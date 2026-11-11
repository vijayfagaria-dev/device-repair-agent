// sessions: one row per session (architecture §4). The id is the browser's UUIDv4 (D08).
import { Outcome } from "@device-repair/shared/protocol";
import { z } from "zod";
import type { Queryable, Tx } from "../tx.js";
import { int, json, parseOptionalRow, timestamp, toJsonParam } from "./rows.js";

export const SESSION_STATUSES = ["active", "finalized", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const sessionSchema = z.object({
  id: z.string(),
  status: z.enum(SESSION_STATUSES),
  outcome: z.enum(Outcome).nullable(),
  version: int,
  currentRevision: int,
  language: z.string(),
  activeCallId: z.string().nullable(),
  openRequestId: z.string().nullable(),
  reviewFlags: z.array(json),
  lastActivityAt: timestamp,
  createdAt: timestamp,
});
export type Session = z.infer<typeof sessionSchema>;

const COLUMNS = `id, status, outcome, version, current_revision AS "currentRevision", language,
  active_call_id AS "activeCallId", open_request_id AS "openRequestId", review_flags AS "reviewFlags",
  last_activity_at AS "lastActivityAt", created_at AS "createdAt"`;

/** Inserts a new session with defaults. Returns null when the id already exists (nothing is changed). */
export async function insertSession(db: Queryable, input: { id: string; language?: string }): Promise<Session | null> {
  const { rows } = await db.query(
    `INSERT INTO sessions (id, language) VALUES ($1, COALESCE($2::text, 'en'))
     ON CONFLICT (id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.id, input.language ?? null],
  );
  return parseOptionalRow("sessions", sessionSchema, rows);
}

export async function getSession(db: Queryable, id: string): Promise<Session | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM sessions WHERE id = $1`, [id]);
  return parseOptionalRow("sessions", sessionSchema, rows);
}

/**
 * Locks the session row until the transaction ends and returns it (null if there is no such session).
 * Every command takes this lock first, which serializes work on one session across processes (D09, D11).
 */
export async function lockSession(tx: Tx, id: string): Promise<Session | null> {
  const { rows } = await tx.query(`SELECT ${COLUMNS} FROM sessions WHERE id = $1 FOR UPDATE`, [id]);
  return parseOptionalRow("sessions", sessionSchema, rows);
}

/** Writes every mutable column of a loaded session. Returns the stored row, or null if the id doesn't exist. */
export async function saveSession(db: Queryable, session: Session): Promise<Session | null> {
  const { rows } = await db.query(
    `UPDATE sessions SET status = $2, outcome = $3, version = $4, current_revision = $5, language = $6,
       active_call_id = $7, open_request_id = $8, review_flags = $9::jsonb, last_activity_at = $10
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      session.id,
      session.status,
      session.outcome,
      session.version,
      session.currentRevision,
      session.language,
      session.activeCallId,
      session.openRequestId,
      toJsonParam(session.reviewFlags),
      session.lastActivityAt,
    ],
  );
  return parseOptionalRow("sessions", sessionSchema, rows);
}

/** Ids of the sessions still collecting (status `active`), most recently active first: boot reconciliation (P4-T01). */
export async function listActiveSessionIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM sessions WHERE status = 'active' ORDER BY last_activity_at DESC, id");
  return rows.map((row) => row.id);
}
