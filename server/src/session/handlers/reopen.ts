// Reopening a finalized session (P7-T05, D16 "after an outcome", PD3a).
//
// Explicit user activity (a card submission, a new call) on a `finalized` session reopens it: the command runs as if
// the session were active, and `session.reopened` is its first event, so the whole change (the reopen and what the
// user did) commits or fails together. The next finalization then produces revision n+1 if its content changed.
// A socket reconnect is not activity and never gets here; `closed` sessions never reopen; after an opt-out the user
// first confirms "Resume your claim?" (canReopen in domain/outcome.ts holds those rules).
import type { Activity } from "../../domain/outcome.js";
import { canReopen } from "../../domain/outcome.js";
import type { Effects } from "../commands.js";
import type { Snapshot } from "../snapshot.js";

/** The snapshot as it is once the session is active again, or null when this activity can't reopen it. */
export function reopenedSnapshot(snapshot: Snapshot, activity: Activity): Snapshot | null {
  if (!canReopen(snapshot.session, activity).reopen) return null;
  return { ...snapshot, session: { ...snapshot.session, status: "active" } };
}

/**
 * The effects of a handler that ran against `reopenedSnapshot(before, …)`, with the reopen added. A handler that did
 * nothing (a stale answer) leaves the session finalized: only a change the user caused reopens it. The handler's own
 * session patch wins (answering "Yes" on "Submit claim?" reopens and finalizes again in one command).
 */
export function withReopen<R>(before: Snapshot, activity: Activity, effects: Effects<R>): Effects<R> {
  const changed = (effects.events?.length ?? 0) > 0 || effects.session !== undefined || effects.record !== undefined || effects.call !== undefined;
  if (!changed) return effects;
  return {
    ...effects,
    events: [
      {
        type: "session.reopened",
        channel: "system",
        payload: { activity, previousOutcome: before.session.outcome, revision: before.session.currentRevision },
      },
      ...(effects.events ?? []),
    ],
    session: { status: "active", ...effects.session },
    activity: true,
  };
}
