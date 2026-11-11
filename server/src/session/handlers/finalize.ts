// Finalization (P6-T01, D16, D17): snapshot → resolve fields → decide the outcome → build and validate the record
// (engagement, cost) → effects that write revision n and finalize the session, in the command's transaction.
//
// `finalizeEffects` is pure and shared: the `Finalize` command runs it for a trigger on its own (the token-gated
// testFinalize, the idle timer in P7-T01), and SubmitChatInput runs it in the same command as the answer that
// triggers it (Yes on "Submit claim?" or on "Stop your claim?"), so the answer and the record commit together.
//
// Persistence (P7-T02, D17): revision = current_revision + 1 is inserted with the session update, the outbox row and
// the `session.finalized` event in one transaction (commands.ts; UNIQUE(session_id, revision) makes a second insert of
// the same revision fail). A finalization whose content hash equals the latest revision's writes no record and no
// outbox row: the session just returns to `finalized` with the revision it already has ("unchanged").
import type { RecordFieldId } from "@device-repair/shared/fields";
import { Outcome, Role } from "@device-repair/shared/protocol";
import { FINALIZED_CANCEL_REASON, finalizedMessage } from "../../agent/chatTemplates.js";
import type { JsonObject } from "../../db/repos/rows.js";
import { computeEngagement } from "../../domain/engagement.js";
import { isFieldId } from "../../domain/fields.js";
import { decideOutcome, type FinalizeTrigger, type ReviewFlag, type ReviewRule } from "../../domain/outcome.js";
import { buildRecord, type ClaimRecord, RecordSchemaError } from "../../domain/record.js";
import type { Effects, EventDraft, Handler, Prepare, SessionPatch } from "../commands.js";
import { newMessageId } from "../ids.js";
import { getLatestRevisionHash } from "../../db/repos/records.js";
import { sessionCost } from "../../metrics/usage.js";
import { resolveFields, type Snapshot, type SnapshotExtras } from "../snapshot.js";
import type { Tx } from "../../db/tx.js";

export interface FinalizeDeps {
  /** A signed, expiring download URL for a stored file (D10). */
  signFileUrl: (fileId: string, now: Date) => string;
  /** AUTO_COMPLETE_ON_IDLE (D16, signed off as true). */
  autoCompleteOnIdle: boolean;
  /** The record builder; replaceable in tests to exercise the schema-failure path. */
  build?: typeof buildRecord;
}

export interface FinalizeOptions {
  trigger: FinalizeTrigger;
  /**
   * When the user tapped Yes on "Submit claim?": `now` when the answer is part of this command; otherwise (undefined)
   * the latest stored Yes. confirmSubmit without a Yes is refused.
   */
  submitConfirmedAt?: Date | null;
  /** Chat messages and chat answers the calling command writes before finalizing (counted in engagement). */
  pending?: { chatMessages?: number; chatAnswers?: number };
  /** Cards the calling command already closed (not cancelled again). */
  handled?: ReadonlySet<string>;
}

/** Where a record broke its schema: JSON pointers and keywords only, never values. */
export type SchemaProblems = readonly { path: string; keyword: string; message: string }[];

export type FinalizeResult =
  | {
      finalized: true;
      revision: number;
      outcome: Outcome;
      reason: string;
      /** Where the first build broke the schema (paths and keywords only), if it did; the record is then needsReview. */
      schemaProblems?: SchemaProblems;
      /** True when the content equals the latest revision's: no new revision, nothing queued for delivery. */
      unchanged: boolean;
      effects: { events: EventDraft[]; session: SessionPatch; record?: NonNullable<Effects["record"]>; timers: NonNullable<Effects["timers"]> };
    }
  | { finalized: false; reason: string };

const RULES = new Set<ReviewRule>(["R-1", "R-2", "R-3", "R-4", "R-5"]);

/** The review flags stored on the session (R-1, R-4, R-5), ignoring anything malformed. */
function storedFlags(raw: readonly unknown[]): ReviewFlag[] {
  return raw.flatMap((item) => {
    const flag = item as { rule?: unknown; reason?: unknown };
    return typeof flag === "object" && flag !== null && RULES.has(flag.rule as ReviewRule) && typeof flag.reason === "string"
      ? [{ rule: flag.rule as ReviewRule, reason: flag.reason }]
      : [];
  });
}

/** The highest attempt count on each record field's cards (R-3: still invalid after 3 attempts). */
export function attemptsByField(snapshot: Pick<Snapshot, "requests">): Partial<Record<RecordFieldId, number>> {
  const attempts: Partial<Record<RecordFieldId, number>> = {};
  for (const request of snapshot.requests) {
    if (!isFieldId(request.field) || request.field === "submitConfirmation") continue;
    const field = request.field as RecordFieldId;
    attempts[field] = Math.max(attempts[field] ?? 0, request.attempts);
  }
  return attempts;
}

/**
 * When the user last tapped Yes on "Submit claim?" (a stored chat answer) since the session was last reopened, or null
 * (D16: a reopened completed session must be confirmed again).
 */
export function storedSubmitConfirmation(snapshot: Pick<Snapshot, "candidates" | "history">): Date | null {
  let latest: { seq: number; at: Date } | null = null;
  for (const c of snapshot.candidates) {
    if (c.field !== "submitConfirmation" || c.source !== "chat" || c.status !== "valid" || c.normalized !== true) continue;
    if (c.eventSeq <= snapshot.history.lastReopenedSeq) continue;
    if (!latest || c.eventSeq > latest.seq) latest = { seq: c.eventSeq, at: c.collectedAt };
  }
  return latest?.at ?? null;
}

export function finalizeEffects(snapshot: Snapshot, options: FinalizeOptions, deps: FinalizeDeps): FinalizeResult {
  const { session, now } = snapshot;
  if (session.status !== "active") return { finalized: false, reason: `session is ${session.status}` };
  if (!snapshot.cost) throw new Error("Finalize needs the session cost: register it with finalizePrepare");
  if (snapshot.latestRecord === undefined) throw new Error("Finalize needs the latest revision: register it with finalizePrepare");

  const fields = resolveFields(snapshot.candidates);
  const flags = storedFlags(session.reviewFlags);
  const submitConfirmedAt = options.submitConfirmedAt !== undefined ? options.submitConfirmedAt : storedSubmitConfirmation(snapshot);
  // completed means confirmed (PD2): the record must carry the Yes it was confirmed with.
  if (options.trigger === "confirmSubmit" && submitConfirmedAt === null) {
    return { finalized: false, reason: "cannot confirm submission: the user hasn't tapped Yes on Submit claim?" };
  }
  const decision = decideOutcome(
    { fields, attempts: attemptsByField(snapshot), submitConfirmed: submitConfirmedAt !== null, storedFlags: flags },
    options.trigger,
    { autoCompleteOnIdle: deps.autoCompleteOnIdle },
  );
  if (!decision.finalize) return { finalized: false, reason: decision.reason };

  const revision = session.currentRevision + 1;
  const engagement = computeEngagement({
    calls: snapshot.calls,
    chatMessages: snapshot.history.chatMessages + (options.pending?.chatMessages ?? 0) + 1, // + the closing message
    chatAnswers: snapshot.candidates.filter((c) => c.source === "chat").length + (options.pending?.chatAnswers ?? 0),
    invalidAttempts: snapshot.requests.reduce((sum, request) => sum + request.attempts, 0),
    now,
  });
  const input = {
    sessionId: session.id,
    revision,
    previousRevision: session.currentRevision > 0 && session.outcome ? { revision: session.currentRevision, outcome: session.outcome } : null,
    outcome: decision.outcome,
    outcomeReason: decision.reason,
    reviewFlags: decision.reviewFlags,
    missingRequired: decision.missingRequired,
    fields,
    submitConfirmedAt: submitConfirmedAt?.toISOString() ?? null,
    engagement,
    cost: snapshot.cost,
    endedAt: now,
    now,
    signFileUrl: (fileId: string) => deps.signFileUrl(fileId, now),
  };
  const build = deps.build ?? buildRecord;
  let built: { record: ClaimRecord; contentHash: string };
  let schemaProblems: SchemaProblems | undefined;
  let sessionFlags = session.reviewFlags;
  try {
    built = build(input);
  } catch (err) {
    if (!(err instanceof RecordSchemaError)) throw err;
    // A record that fails its own schema is a bug (D17, R-5): the claim goes to a human, with the reason.
    schemaProblems = err.problems;
    const flag: ReviewFlag = { rule: "R-5", reason: "the record failed its schema" };
    const reviewFlags = [...decision.reviewFlags, flag];
    built = build({ ...input, outcome: Outcome.NEEDS_REVIEW, outcomeReason: `needs review: ${reviewFlags.map((f) => `${f.rule} ${f.reason}`).join("; ")}`, reviewFlags });
    sessionFlags = [...session.reviewFlags, { rule: flag.rule, reason: flag.reason }];
  }
  const { record, contentHash } = built;
  // Unchanged content gives no new revision (D17): only when this finalization would have been the next revision of
  // a claim that already has one with the same hash (the hash covers the outcome, so the outcome is the same too).
  const unchanged = snapshot.latestRecord !== null && snapshot.latestRecord.contentHash === contentHash;

  const events: EventDraft[] = [];
  // Outstanding cards close with the session (D16: "outstanding cards cancelled"), except on `partial`: the returning
  // user carries on with the card that was open (P7-T05).
  for (const request of snapshot.requests) {
    if (record.outcome === Outcome.PARTIAL) break;
    if ((request.status !== "open" && request.status !== "queued") || options.handled?.has(request.id)) continue;
    events.push({
      type: "input.cancelled",
      channel: "chat",
      payload: { requestId: request.id, reason: FINALIZED_CANCEL_REASON },
      inputRequestUpdate: { id: request.id, status: "cancelled" },
    });
  }
  const shownRevision = unchanged ? session.currentRevision : revision;
  events.push({
    type: "session.finalized",
    channel: "system",
    // schemaProblems (paths and keywords only) when the first build broke the schema: the timeline and the error log.
    payload: {
      outcome: record.outcome,
      revision: shownRevision,
      previousRevision: record.previousRevision?.revision ?? null,
      trigger: options.trigger,
      reason: record.outcomeReason,
      contentHash,
      ...(unchanged ? { unchanged: true } : {}),
      ...(schemaProblems ? { schemaProblems: schemaProblems.map((p) => ({ ...p })) } : {}),
    },
  });
  events.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: finalizedMessage(record.outcome) } });

  return {
    finalized: true,
    revision: shownRevision,
    outcome: record.outcome,
    reason: record.outcomeReason,
    unchanged,
    ...(schemaProblems ? { schemaProblems } : {}),
    effects: {
      events,
      session: { status: "finalized", outcome: record.outcome, currentRevision: shownRevision, reviewFlags: sessionFlags },
      ...(unchanged ? {} : { record: { revision, outcome: record.outcome, payload: record as unknown as JsonObject, contentHash } }),
      timers: { clear: ["noCallStart"] },
    },
  };
}

/** Loads the cost a record needs (P3-T07 ledger), in the command's transaction. */
export const finalizePrepare: Prepare = (tx, snapshot) => finalizeExtras(tx, snapshot.session.id);

/** What a finalization reads beyond the snapshot: the session's cost, and the latest revision (for the dedup check). */
export async function finalizeExtras(tx: Tx, sessionId: string): Promise<Pick<SnapshotExtras, "cost" | "latestRecord">> {
  // One statement at a time: a transaction is one connection.
  const cost = await sessionCost(tx, sessionId);
  const latestRecord = await getLatestRevisionHash(tx, sessionId);
  return { cost, latestRecord };
}

export interface Finalize {
  type: "Finalize";
  trigger: FinalizeTrigger;
}

export type FinalizeReply =
  | { finalized: true; revision: number; outcome: Outcome; unchanged?: boolean; schemaProblems?: SchemaProblems }
  | { finalized: false; reason: string };

/** The Finalize command: one trigger, nothing else in the same command. */
export const finalizeHandler =
  (deps: FinalizeDeps): Handler<Finalize, FinalizeReply> =>
  (snapshot, { trigger }) => {
    const result = finalizeEffects(snapshot, { trigger }, deps);
    if (!result.finalized) return { reply: result };
    const { revision, outcome, schemaProblems, unchanged, effects } = result;
    return { ...effects, reply: { finalized: true, revision, outcome, ...(unchanged ? { unchanged } : {}), ...(schemaProblems ? { schemaProblems } : {}) } };
  };
