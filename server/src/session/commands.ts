// The command processor (D11, P3-T01): the single writer of session state.
//
// dispatch(sessionId, command):
//   per-session mutex → one transaction: lock the session row FIRST (FOR UPDATE, so ordering also holds across two
//   processes), load the snapshot, run the pure handler, write its effects (events + the rows tied to them, session
//   row, timers) → COMMIT → publish the committed update to the hub → release the mutex → post-commit reactions
//   (the chat planner's reconcile, P4-T01).
//
// Handlers never touch the database or a provider: they get a snapshot and return effects, so they are fast and
// deterministic, and a throwing handler leaves nothing behind (the transaction rolls back and nothing is published).
//
// Publishing happens after COMMIT but just before the mutex is released (D11 says "after releasing"): publish is
// synchronous and never awaits a listener, so it can't deadlock, and doing it inside the mutex guarantees that the
// hub sees one session's commits in commit order. Reactions, which may dispatch more commands, run after release.
//
// A command may register a `prepare` step (P6-T01): extra reads that only it needs (the session's cost for a record,
// its uploads for a file answer), run in the same transaction after the snapshot, so the handler stays pure.
import type { FieldSource, Outcome, Role } from "@device-repair/shared/protocol";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { endCall, insertCall } from "../db/repos/calls.js";
import { appendEvent, type EventChannel, type SessionEvent } from "../db/repos/events.js";
import { insertChatMessage } from "../db/repos/chatMessages.js";
import { type CandidateStatus, insertFieldCandidate } from "../db/repos/fieldCandidates.js";
import { type InputRequestStatus, insertInputRequest, saveInputRequest, type StoredInputRequest } from "../db/repos/inputRequests.js";
import { insertOutbox, WEBHOOK_TARGET } from "../db/repos/outbox.js";
import { insertRecord } from "../db/repos/records.js";
import type { JsonObject, JsonValue } from "../db/repos/rows.js";
import { lockSession, saveSession, type Session } from "../db/repos/sessions.js";
import { deleteTimer, type TimerKind, upsertTimer } from "../db/repos/timers.js";
import { insertTranscriptLine } from "../db/repos/transcriptLines.js";
import { type Tx, withTx } from "../db/tx.js";
import { failpoint } from "../util/failpoints.js";
import type { SessionHub, SessionUpdate } from "./hub.js";
import { KeyedMutex } from "./mutex.js";
import { loadSnapshot, type Snapshot, type SnapshotExtras } from "./snapshot.js";

export interface Command {
  readonly type: string;
}

/** One event to append, with the row it introduces (if any). The row's data is copied into the event payload. */
export interface EventDraft {
  type: string;
  channel: EventChannel;
  payload?: JsonObject;
  chatMessage?: { id: string; role: Role; text: string; requestId?: string | null };
  transcriptLine?: { id: string; callId: string; role: Role; text: string; interrupted?: boolean; startedAt: Date };
  /** A new input card. */
  inputRequest?: { id: string; field: string; spec: JsonObject; status: InputRequestStatus };
  /** A status or attempts change on an existing card of this session. */
  inputRequestUpdate?: { id: string; status: InputRequestStatus; attempts?: number };
  candidate?: {
    field: string;
    source: FieldSource;
    raw: JsonValue;
    normalized?: JsonValue | null;
    status: CandidateStatus;
    error?: string | null;
    userConfirmed?: boolean;
    evidence?: string | null;
  };
}

/** Session columns a handler may change. `version`, `lastActivityAt` and `openRequestId` are maintained here. */
export type SessionPatch = Partial<Pick<Session, "status" | "outcome" | "currentRevision" | "activeCallId" | "reviewFlags" | "language">>;

/** What a handler decided. Everything is optional: an empty result is a no-op that writes and publishes nothing. */
export interface Effects<R = unknown> {
  events?: readonly EventDraft[];
  session?: SessionPatch;
  timers?: { set?: readonly { kind: TimerKind; dueAt: Date }[]; clear?: readonly TimerKind[] };
  /** Explicit user activity (P3-T05): moves `lastActivityAt`, the idle timer and the session-expiry timer. */
  activity?: boolean;
  /** A call starting or ending (P5-T02): the `calls` row, written before the events. */
  call?: { start?: { id: string; startedAt: Date }; end?: { id: string; reason: string; endedAt: Date } };
  /**
   * A new record revision (P6-T01), inserted in this transaction together with its outbox row (P7-T02) and carried on
   * the published update.
   */
  record?: { revision: number; outcome: Outcome; payload: JsonObject; contentHash: string };
  /** Returned to the dispatcher; never persisted. */
  reply?: R;
}

export type Handler<C extends Command = Command, R = unknown> = (snapshot: Snapshot, command: C) => Effects<R>;

/** Extra reads for one command, inside its transaction and under the session lock; merged into the snapshot. */
export type Prepare<C extends Command = Command> = (tx: Tx, snapshot: Snapshot, command: C) => Promise<SnapshotExtras>;

export interface HandlerOptions<C extends Command = Command> {
  prepare?: Prepare<C>;
}

export interface TimerSettings {
  /** IDLE_TIMEOUT_SECONDS (D16): no call and no user activity for this long → the idle timer fires. */
  idleTimeoutMs: number;
  /** SESSION_LIFETIME_SECONDS (PD3a): last activity + this → the session-expiry timer fires. */
  sessionLifetimeMs: number;
}

/**
 * A post-commit reaction (D11): runs after every command and on demand; may dispatch more commands. `command` is the
 * command it follows (null on demand: chat connect, boot), `update` what that command committed (null for a no-op).
 */
export type Reaction = (sessionId: string, update: SessionUpdate | null, command: Command | null) => Promise<void> | void;

export interface DispatchResult<R> {
  reply: R | undefined;
  /** What was committed and published; null when the handler decided on a no-op. */
  update: SessionUpdate | null;
}

export class UnsupportedCommandError extends Error {
  constructor(readonly commandType: string) {
    super(`no handler for command "${commandType}"`);
    this.name = "UnsupportedCommandError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super("session not found");
    this.name = "SessionNotFoundError";
  }
}

export interface CommandProcessorOptions {
  pool: pg.Pool;
  hub: SessionHub;
  log: FastifyBaseLogger;
  timers: TimerSettings;
  now?: () => Date;
  /** Told about every timer due time a command committed, so the sweeper can wake earlier (P3-T05). */
  onTimerScheduled?: (dueAt: Date) => void;
  /** Handlers slower than this are logged (plan risk: one slow handler blocks its session). */
  slowHandlerMs?: number;
  /** Told after a command committed a record, so the outbox worker can deliver it at once (P7-T03). */
  onOutboxQueued?: () => void;
  /**
   * Called inside the transaction after every write and before COMMIT, with the name `beforeCommit`; throwing aborts
   * the command with nothing written. For crash tests (P7-T02, P8-T03); production never sets it.
   */
  failpoint?: (name: "beforeCommit") => void | Promise<void>;
}

interface Executed {
  reply: unknown;
  update: SessionUpdate | null;
  scheduled: Date[];
  queuedDelivery: boolean;
}

export class CommandProcessor {
  readonly #pool: pg.Pool;
  readonly #hub: SessionHub;
  readonly #log: FastifyBaseLogger;
  readonly #timers: TimerSettings;
  readonly #now: () => Date;
  readonly #slowHandlerMs: number;
  readonly #mutex = new KeyedMutex();
  readonly #handlers = new Map<string, { handler: Handler; prepare?: Prepare }>();
  readonly #reactions: Reaction[] = [];
  #onTimerScheduled: ((dueAt: Date) => void) | undefined;
  #onOutboxQueued: (() => void) | undefined;
  #inflight = 0;
  readonly #failpoint: CommandProcessorOptions["failpoint"];

  constructor(options: CommandProcessorOptions) {
    this.#pool = options.pool;
    this.#hub = options.hub;
    this.#log = options.log;
    this.#timers = options.timers;
    this.#now = options.now ?? (() => new Date());
    this.#slowHandlerMs = options.slowHandlerMs ?? 5;
    this.#onTimerScheduled = options.onTimerScheduled;
    this.#onOutboxQueued = options.onOutboxQueued;
    this.#failpoint = options.failpoint;
  }

  register<C extends Command, R>(type: C["type"], handler: Handler<C, R>, options: HandlerOptions<C> = {}): this {
    if (this.#handlers.has(type)) throw new Error(`handler for "${type}" already registered`);
    this.#handlers.set(type, { handler: handler as unknown as Handler, prepare: options.prepare as Prepare | undefined });
    return this;
  }

  /** Adds a post-commit reaction (the chat planner's reconcile registers here in P4-T01). */
  addReaction(reaction: Reaction): this {
    this.#reactions.push(reaction);
    return this;
  }

  /** Where newly committed timer due times are reported (set once the sweeper exists). */
  set onTimerScheduled(listener: ((dueAt: Date) => void) | undefined) {
    this.#onTimerScheduled = listener;
  }

  /** Where a committed record's delivery is announced (set once the outbox worker exists, P7-T03). */
  set onOutboxQueued(listener: (() => void) | undefined) {
    this.#onOutboxQueued = listener;
  }

  /** Reports a timer committed outside a command (a new session's noCallStart, ensureSession) to the same listener. */
  timerScheduled(dueAt: Date): void {
    this.#onTimerScheduled?.(dueAt);
  }

  /** Commands queued or running in this process (for leak checks in tests). */
  get busySessions(): number {
    return this.#mutex.size;
  }

  /** Waits until every dispatch in this process has finished, reactions included (shutdown, P8-T02). False on timeout. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inflight > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  async dispatch<R = unknown>(sessionId: string, command: Command): Promise<DispatchResult<R>> {
    this.#inflight += 1;
    try {
      return await this.#dispatch<R>(sessionId, command);
    } finally {
      this.#inflight -= 1;
    }
  }

  async #dispatch<R>(sessionId: string, command: Command): Promise<DispatchResult<R>> {
    const registered = this.#handlers.get(command.type);
    if (!registered) throw new UnsupportedCommandError(command.type);
    const executed = await this.#mutex.run(sessionId, async () => {
      const result = await withTx(this.#pool, (tx) => this.#execute(tx, sessionId, command, registered));
      // Chaos tests (P8-T03): die right after COMMIT, before anything that follows a commit has run.
      if (result.queuedDelivery) failpoint("finalize.afterCommit");
      failpoint(`commit.after.${command.type}`);
      if (result.update) this.#hub.publish(result.update);
      return result;
    });
    for (const dueAt of executed.scheduled) this.#onTimerScheduled?.(dueAt);
    if (executed.queuedDelivery) this.#onOutboxQueued?.();
    await this.react(sessionId, executed.update, command);
    return { reply: executed.reply as R | undefined, update: executed.update };
  }

  /**
   * Runs the post-commit reactions. Called after every command, and on demand: on chat connect (protocol.md §4
   * step 5) and at boot (P8-T01). A failing reaction is logged; the command it followed stays committed.
   */
  async react(sessionId: string, update: SessionUpdate | null = null, command: Command | null = null): Promise<void> {
    for (const reaction of this.#reactions) {
      try {
        await reaction(sessionId, update, command);
      } catch (err) {
        this.#log.error({ sessionId, err }, "post-commit reaction failed");
      }
    }
  }

  async #execute(tx: Tx, sessionId: string, command: Command, { handler, prepare }: { handler: Handler; prepare?: Prepare }): Promise<Executed> {
    const session = await lockSession(tx, sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    const now = this.#now();
    const loaded = await loadSnapshot(tx, session, now);
    const snapshot: Snapshot = prepare ? { ...loaded, ...(await prepare(tx, loaded, command)) } : loaded;

    const started = performance.now();
    const effects = handler(snapshot, command);
    const elapsedMs = performance.now() - started;
    if (elapsedMs > this.#slowHandlerMs) this.#log.warn({ sessionId, command: command.type, elapsedMs }, "slow command handler");

    const drafts = effects.events ?? [];
    const timerPlan = planTimers(snapshot, { ...session, ...effects.session }, effects, this.#timers);
    const timerWrites = [...timerPlan].filter(([kind, dueAt]) => {
      const existing = snapshot.timers.find((timer) => timer.kind === kind);
      return dueAt === null ? existing !== undefined : existing?.dueAt.getTime() !== dueAt.getTime();
    });
    if (drafts.length === 0 && !effects.session && !effects.activity && !effects.record && !effects.call && timerWrites.length === 0) {
      return { reply: effects.reply, update: null, scheduled: [], queuedDelivery: false };
    }

    if (effects.call?.start) await insertCall(tx, { id: effects.call.start.id, sessionId, startedAt: effects.call.start.startedAt });
    if (effects.call?.end) await endCall(tx, { id: effects.call.end.id, reason: effects.call.end.reason, endedAt: effects.call.end.endedAt });

    const requests = new Map(snapshot.requests.map((request) => [request.id, request]));
    const events: SessionEvent[] = [];
    for (const [index, draft] of drafts.entries()) {
      events.push(await writeEvent(tx, sessionId, snapshot.lastSeq + 1 + index, draft, requests));
    }

    if (effects.record) {
      await insertRecord(tx, { sessionId, ...effects.record });
      // The delivery is queued in the record's own transaction: a crash before COMMIT leaves neither, after it both
      // (D17), and a restart finds the row and delivers (P8-T01).
      await insertOutbox(tx, { sessionId, revision: effects.record.revision, target: WEBHOOK_TARGET });
    }

    // At most one card is open per session; the partial unique index input_requests_one_open_idx enforces it, so a
    // second open card has already failed the command (and rolled it back) by here.
    const open = [...requests.values()].find((request) => request.status === "open");
    const saved = await saveSession(tx, {
      ...session,
      ...effects.session,
      openRequestId: open?.id ?? null,
      lastActivityAt: effects.activity ? now : session.lastActivityAt,
      version: session.version + 1,
    });
    if (!saved) throw new SessionNotFoundError(sessionId);

    const scheduled: Date[] = [];
    for (const [kind, dueAt] of timerWrites) {
      if (dueAt === null) await deleteTimer(tx, sessionId, kind);
      else {
        await upsertTimer(tx, { sessionId, kind, dueAt });
        scheduled.push(dueAt);
      }
    }
    const update: SessionUpdate = { sessionId, events, session: saved };
    if (effects.record) update.record = { revision: effects.record.revision, payload: effects.record.payload };
    if (effects.record) failpoint("finalize.beforeCommit");
    await this.#failpoint?.("beforeCommit");
    return { reply: effects.reply, update, scheduled, queuedDelivery: effects.record !== undefined };
  }
}

/**
 * The timers the command leaves behind (P3-T05): the handler's own changes, then the activity rules.
 * - User activity moves `sessionExpiry` to now + lifetime (unless the session is closed).
 * - `idle` exists only while the session is active with no call: a call removes it, and activity or the end of a
 *   call (re-)arms it to now + idle timeout.
 */
function planTimers(snapshot: Snapshot, after: Session, effects: Effects, settings: TimerSettings): Map<TimerKind, Date | null> {
  const plan = new Map<TimerKind, Date | null>();
  for (const kind of effects.timers?.clear ?? []) plan.set(kind, null);
  for (const { kind, dueAt } of effects.timers?.set ?? []) plan.set(kind, dueAt);
  const now = snapshot.now.getTime();
  if (effects.activity && after.status !== "closed") plan.set("sessionExpiry", new Date(now + settings.sessionLifetimeMs));
  const idleApplies = after.status === "active" && after.activeCallId === null;
  const callEnded = snapshot.session.activeCallId !== null && after.activeCallId === null;
  if (!idleApplies) plan.set("idle", null);
  else if (effects.activity || callEnded) plan.set("idle", new Date(now + settings.idleTimeoutMs));
  return plan;
}

/** Appends one event at `seq` and writes the row it introduces; the row's data goes into the payload too. */
async function writeEvent(tx: Tx, sessionId: string, seq: number, draft: EventDraft, requests: Map<string, StoredInputRequest>): Promise<SessionEvent> {
  const payload: JsonObject = { ...draft.payload };
  if (draft.chatMessage) {
    const { id, role, text, requestId = null } = draft.chatMessage;
    await insertChatMessage(tx, { id, sessionId, eventSeq: seq, role, text, requestId });
    payload.message = { id, role, text, requestId };
  }
  if (draft.transcriptLine) {
    const line = draft.transcriptLine;
    await insertTranscriptLine(tx, { ...line, sessionId, eventSeq: seq });
    payload.line = { id: line.id, callId: line.callId, role: line.role, text: line.text, interrupted: line.interrupted ?? false };
  }
  if (draft.inputRequest) {
    const stored = await insertInputRequest(tx, { sessionId, ...draft.inputRequest });
    requests.set(stored.id, stored);
    payload.request = { id: stored.id, field: stored.field, status: stored.status, attempts: stored.attempts, spec: stored.spec };
  }
  if (draft.inputRequestUpdate) {
    const { id, status, attempts } = draft.inputRequestUpdate;
    const current = requests.get(id);
    if (!current) throw new Error(`no input request ${id} in this session`);
    const stored = await saveInputRequest(tx, { sessionId, id, status, attempts: attempts ?? current.attempts });
    if (!stored) throw new Error(`input request ${id} vanished`);
    requests.set(id, stored);
    payload.request = { id, field: stored.field, status: stored.status, attempts: stored.attempts, spec: stored.spec };
  }
  if (draft.candidate) {
    const candidate = draft.candidate;
    await insertFieldCandidate(tx, { sessionId, eventSeq: seq, ...candidate });
    // Evidence (the LLM's quote of the transcript) stays in its row; the timeline shows the decision, not the quote.
    payload.candidate = {
      field: candidate.field,
      source: candidate.source,
      status: candidate.status,
      raw: candidate.raw,
      normalized: candidate.normalized ?? null,
      error: candidate.error ?? null,
      userConfirmed: candidate.userConfirmed ?? false,
    };
  }
  return appendEvent(tx, { sessionId, seq, type: draft.type, channel: draft.channel, payload });
}
