// TimerFired (P3-T05): the sweeper's command for a due persisted timer. Idempotent: it re-checks the timer under the
// session lock, so a timer that was moved, cleared or already fired (by another sweeper) is a no-op.
// What a fired timer leads to (P7-T01, P7-T05):
// - idle: the user stopped engaging → finalize with the `idleTimeout` trigger (D16): `partial`, or `completed`
//   (AUTO_COMPLETE_ON_IDLE) or `needsReview` by the decision table. The finalization rides in the same command.
// - sessionExpiry (PD3a): 7 days after the last activity. A finalization still pending runs first, so every session
//   gets a record, then the session is `closed`: it can't be reopened and no revision follows.
// Everything else is recorded as a `timer.fired` event and the timer removed.
// noCallStart (PD10, P4-T04): the page was opened but no call started within the deadline, so the chat takes over:
// `chat.started` switches the planner to chat mode, which then opens the first card.
import { Role } from "@device-repair/shared/protocol";
import { cancelDraft } from "../../agent/chatPlanner.js";
import { CHAT_START_MESSAGE } from "../../agent/chatTemplates.js";
import type { TimerKind } from "../../db/repos/timers.js";
import type { Effects, EventDraft, Handler, Prepare } from "../commands.js";
import { newMessageId } from "../ids.js";
import type { Snapshot } from "../snapshot.js";
import { type FinalizeDeps, finalizeEffects, finalizeExtras } from "./finalize.js";

export interface TimerFired {
  type: "TimerFired";
  kind: TimerKind;
  /** The due time the sweeper saw (for the log); the stored one is what counts. */
  dueAt: Date;
}

export type TimerFiredReply =
  | { fired: true; finalized?: { revision: number; outcome: string; unchanged?: boolean }; closed?: boolean }
  | { fired: false; reason: "notDue" | "callActive" | "notActive" | "notNeeded" };

/** The reads a finalizing timer needs (cost, latest revision); the others read nothing extra. */
export const timerFiredPrepare: Prepare<TimerFired> = async (tx, snapshot, { kind }) =>
  (kind === "idle" || kind === "sessionExpiry") && snapshot.session.status === "active" ? finalizeExtras(tx, snapshot.session.id) : {};

export const timerFiredHandler =
  (deps: FinalizeDeps): Handler<TimerFired, TimerFiredReply> =>
  (snapshot, command): Effects<TimerFiredReply> => {
  const { kind } = command;
  const timer = snapshot.timers.find((candidate) => candidate.kind === kind);
  // Gone (fired elsewhere or cleared) or moved later by activity since the sweeper read it.
  if (!timer || timer.dueAt.getTime() > snapshot.now.getTime()) return { reply: { fired: false, reason: "notDue" } };
  if (kind === "idle") {
    // Never during a call (the call's end re-arms it), and only while the session is active.
    if (snapshot.session.activeCallId !== null) return { timers: { clear: ["idle"] }, reply: { fired: false, reason: "callActive" } };
    if (snapshot.session.status !== "active") return { timers: { clear: ["idle"] }, reply: { fired: false, reason: "notActive" } };
    return finalizing(snapshot, timer.dueAt, "idle", deps, false);
  }
  if (kind === "sessionExpiry") return expire(snapshot, timer.dueAt, deps);
  if (kind === "noCallStart") {
    // A call happened (or is on), the chat already started, or the session is done: nothing to switch.
    if (snapshot.session.status !== "active" || snapshot.calls.length > 0 || snapshot.history.chatStarted) {
      return { timers: { clear: ["noCallStart"] }, reply: { fired: false, reason: "notNeeded" } };
    }
    return {
      timers: { clear: ["noCallStart"] },
      events: [
        { type: "timer.fired", channel: "system", payload: { kind, dueAt: timer.dueAt.toISOString() } },
        { type: "chat.started", channel: "chat", payload: { reason: "noCallStart" } },
        { type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: CHAT_START_MESSAGE } },
      ],
      reply: { fired: true },
    };
  }
  return {
    timers: { clear: [kind] },
    events: [{ type: "timer.fired", channel: "system", payload: { kind, dueAt: timer.dueAt.toISOString() } }],
    reply: { fired: true },
  };
};

const firedEvent = (kind: TimerKind, dueAt: Date): EventDraft => ({ type: "timer.fired", channel: "system", payload: { kind, dueAt: dueAt.toISOString() } });

/** Cards still waiting for an answer, cancelled with the reason (a closed session takes no answers). */
function cancelPending(snapshot: Snapshot, alreadyCancelled: ReadonlySet<string>): EventDraft[] {
  return snapshot.requests
    .filter((request) => (request.status === "open" || request.status === "queued") && !alreadyCancelled.has(request.id))
    .map((request) => cancelDraft(request.id, "session closed"));
}

/** The idle timer, or the expiry timer on a session that is still active: finalize (and, for expiry, close). */
function finalizing(snapshot: Snapshot, dueAt: Date, kind: TimerKind, deps: FinalizeDeps, close: boolean): Effects<TimerFiredReply> {
  const fired = firedEvent(kind, dueAt);
  const result = finalizeEffects(snapshot, { trigger: "idleTimeout" }, deps);
  // idleTimeout always finalizes (decideOutcome); an active session that somehow can't just loses the timer.
  if (!result.finalized) return { timers: { clear: [kind] }, events: [fired], reply: { fired: true } };
  const { events, ...effects } = result.effects;
  const cancelled = new Set(events.flatMap((e) => (e.inputRequestUpdate?.status === "cancelled" ? [e.inputRequestUpdate.id] : [])));
  const closing: EventDraft[] = close ? [{ type: "session.closed", channel: "system", payload: { revision: result.revision } }, ...cancelPending(snapshot, cancelled)] : [];
  return {
    ...effects,
    events: [fired, ...events, ...closing],
    session: close ? { ...effects.session, status: "closed" } : effects.session,
    timers: { clear: [...(effects.timers.clear ?? []), kind, ...(close ? (["idle", "noCallStart"] as const) : [])] },
    reply: {
      fired: true,
      finalized: { revision: result.revision, outcome: result.outcome, ...(result.unchanged ? { unchanged: true } : {}) },
      ...(close ? { closed: true } : {}),
    },
  };
}

/** PD3a: a pending finalization first, then `closed`: read-only forever, no new revision. */
function expire(snapshot: Snapshot, dueAt: Date, deps: FinalizeDeps): Effects<TimerFiredReply> {
  if (snapshot.session.status === "closed") return { timers: { clear: ["sessionExpiry"] }, reply: { fired: false, reason: "notActive" } };
  if (snapshot.session.status === "active") return finalizing(snapshot, dueAt, "sessionExpiry", deps, true);
  return {
    timers: { clear: ["sessionExpiry", "idle", "noCallStart"] },
    session: { status: "closed" },
    events: [firedEvent("sessionExpiry", dueAt), { type: "session.closed", channel: "system", payload: { revision: snapshot.session.currentRevision } }, ...cancelPending(snapshot, new Set())],
    reply: { fired: true, closed: true },
  };
}
