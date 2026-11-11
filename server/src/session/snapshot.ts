// The session snapshot a command handler sees (D11 step 1): everything about one session that decisions depend on,
// read inside the command's transaction after the session row lock, so it can't change underneath the handler.
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { type Call, listCalls } from "../db/repos/calls.js";
import { type FieldCandidate, listFieldCandidates } from "../db/repos/fieldCandidates.js";
import type { StoredFile } from "../db/repos/files.js";
import { listInputRequests, type StoredInputRequest } from "../db/repos/inputRequests.js";
import type { Session } from "../db/repos/sessions.js";
import { listTimers, type Timer } from "../db/repos/timers.js";
import type { Queryable } from "../db/tx.js";
import { type Candidate, type ResolvedField, resolveField } from "../domain/conflicts.js";
import { isFieldId } from "../domain/fields.js";
import type { SessionCost } from "../metrics/usage.js";

/** Facts about the session's event history that decisions need, read in the same statement as the last seq. */
export interface HistoryFacts {
  /** `chat.message` events so far (agent and user): the record's engagement.chatMessages. */
  chatMessages: number;
  /** The `noCallStart` deadline passed without a call: the chat planner runs the flow in chat (PD10, P4-T04). */
  chatStarted: boolean;
  /** The planner already said it has nothing more it can ask (`chat.stalled`), so it doesn't say it again. */
  chatStalled: boolean;
  /** The seq of the latest `session.reopened` event (0 for none): a "Yes" before it no longer confirms (D16, P7-T05). */
  lastReopenedSeq: number;
}

/**
 * Reads only some commands need, loaded by their `prepare` step (CommandProcessor.register) inside the same
 * transaction: the session's uploads (to check `file:` refs) and its cost (for a record).
 */
export interface SnapshotExtras {
  files?: readonly StoredFile[];
  cost?: SessionCost;
  /** The latest record revision's number and content hash, or null for none (the dedup check, P7-T02). */
  latestRecord?: { revision: number; contentHash: string } | null;
}

export interface Snapshot extends SnapshotExtras {
  readonly session: Readonly<Session>;
  /** The last event seq so far (0 for none); the command's events continue from here. */
  readonly lastSeq: number;
  readonly history: Readonly<HistoryFacts>;
  readonly timers: readonly Timer[];
  /** Every input card of the session, oldest first. */
  readonly requests: readonly StoredInputRequest[];
  /** The append-only candidate history of every field, in insertion order. */
  readonly candidates: readonly FieldCandidate[];
  /** Every call of the session, oldest first (at most one without `endedAt`). */
  readonly calls: readonly Call[];
  /** The command's clock reading: one instant for the whole command. */
  readonly now: Date;
}

/** Reads the rest of the snapshot. The caller holds the session row lock (lockSession) for the transaction. */
export async function loadSnapshot(db: Queryable, session: Session, now: Date): Promise<Snapshot> {
  // One after another: a transaction is one connection, which runs one statement at a time.
  const { rows } = await db.query<{ seq: number; chatMessages: number; chatStarted: boolean; chatStalled: boolean; lastReopenedSeq: number }>(
    `SELECT COALESCE(max(seq), 0)::int AS seq,
       count(*) FILTER (WHERE type = 'chat.message')::int AS "chatMessages",
       COALESCE(bool_or(type = 'chat.started'), false) AS "chatStarted",
       COALESCE(bool_or(type = 'chat.stalled'), false) AS "chatStalled",
       COALESCE(max(seq) FILTER (WHERE type = 'session.reopened'), 0)::int AS "lastReopenedSeq"
     FROM events WHERE session_id = $1`,
    [session.id],
  );
  const facts = rows[0];
  const timers = await listTimers(db, session.id);
  const requests = await listInputRequests(db, session.id);
  const candidates = await listFieldCandidates(db, session.id);
  const calls = await listCalls(db, session.id);
  return {
    session,
    lastSeq: Number(facts?.seq ?? 0),
    history: { chatMessages: Number(facts?.chatMessages ?? 0), chatStarted: facts?.chatStarted === true, chatStalled: facts?.chatStalled === true, lastReopenedSeq: Number(facts?.lastReopenedSeq ?? 0) },
    timers,
    requests,
    candidates,
    calls,
    now,
  };
}

/** A stored candidate as the conflict resolver takes it (P2-T05). */
function toDomainCandidate(row: FieldCandidate): Candidate {
  return {
    source: row.source,
    seq: row.eventSeq,
    collectedAt: row.collectedAt.toISOString(),
    status: row.status,
    normalized: row.normalized,
    userConfirmed: row.userConfirmed,
  };
}

/** The effective value of every record field, computed from the candidate history (never stored, architecture §4). */
export function resolveFields(candidates: readonly FieldCandidate[]): Record<RecordFieldId, ResolvedField> {
  const byField = new Map<string, Candidate[]>();
  for (const row of candidates) {
    if (!isFieldId(row.field)) continue; // control fields (e.g. submitConfirmation) aren't record fields
    byField.set(row.field, [...(byField.get(row.field) ?? []), toDomainCandidate(row)]);
  }
  return Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, resolveField(id, byField.get(id) ?? [])])) as Record<RecordFieldId, ResolvedField>;
}
