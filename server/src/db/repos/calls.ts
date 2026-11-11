// calls: voice calls. At most one active (not ended) call per session (partial unique index; close code 4409).
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { parseOptionalRow, parseReturnedRow, parseRows, timestamp } from "./rows.js";

const callSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  endReason: z.string().nullable(),
});
export type Call = z.infer<typeof callSchema>;

const COLUMNS = `id, session_id AS "sessionId", started_at AS "startedAt", ended_at AS "endedAt", end_reason AS "endReason"`;

/** Starts a call. Fails with 23505 (calls_one_active_idx) if the session already has an active call. */
export async function insertCall(db: Queryable, call: { id: string; sessionId: string; startedAt?: Date }): Promise<Call> {
  const { rows } = await db.query(
    `INSERT INTO calls (id, session_id, started_at) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
     RETURNING ${COLUMNS}`,
    [call.id, call.sessionId, call.startedAt ?? null],
  );
  return parseReturnedRow("calls", callSchema, rows);
}

export async function getCall(db: Queryable, id: string): Promise<Call | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM calls WHERE id = $1`, [id]);
  return parseOptionalRow("calls", callSchema, rows);
}

export async function getActiveCall(db: Queryable, sessionId: string): Promise<Call | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM calls WHERE session_id = $1 AND ended_at IS NULL`, [sessionId]);
  return parseOptionalRow("calls", callSchema, rows);
}

/** Ends an active call. Returns null if the call doesn't exist or has already ended (the first end wins). */
export async function endCall(db: Queryable, end: { id: string; reason: string; endedAt?: Date }): Promise<Call | null> {
  const { rows } = await db.query(
    `UPDATE calls SET ended_at = COALESCE($2::timestamptz, now()), end_reason = $3 WHERE id = $1 AND ended_at IS NULL
     RETURNING ${COLUMNS}`,
    [end.id, end.endedAt ?? null, end.reason],
  );
  return parseOptionalRow("calls", callSchema, rows);
}

/** Calls with no end: after a clean run there is at most one per session; after a crash they are what recovery closes. */
export async function listOpenCalls(db: Queryable): Promise<Call[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM calls WHERE ended_at IS NULL ORDER BY started_at, id`);
  return parseRows("calls", callSchema, rows);
}

/** (session, call) pairs where a session still points at a call: recovery ends them even if the call row says it ended. */
export async function listActiveCallPointers(db: Queryable): Promise<{ sessionId: string; callId: string }[]> {
  const { rows } = await db.query<{ sessionId: string; callId: string }>(`SELECT id AS "sessionId", active_call_id AS "callId" FROM sessions WHERE active_call_id IS NOT NULL`);
  return rows;
}

/** The session's calls, oldest first (engagement and the chat planner's mode). */
export async function listCalls(db: Queryable, sessionId: string): Promise<Call[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM calls WHERE session_id = $1 ORDER BY started_at, id`, [sessionId]);
  return parseRows("calls", callSchema, rows);
}
