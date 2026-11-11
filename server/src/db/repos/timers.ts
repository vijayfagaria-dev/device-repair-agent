// timers: persisted business deadlines (D16), one per kind per session.
import { z } from "zod";
import type { Queryable, Tx } from "../tx.js";
import { checkLimit, parseReturnedRow, parseRows, timestamp } from "./rows.js";

/** How many timers are overdue right now (the boot recovery count; the sweeper fires them). */
export async function countOverdueTimers(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM timers WHERE due_at <= now()");
  return Number(rows[0]?.n ?? 0);
}

export const TIMER_KINDS = ["idle", "noCallStart", "orphanUploads", "sessionExpiry"] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

const timerSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(TIMER_KINDS),
  dueAt: timestamp,
});
export type Timer = z.infer<typeof timerSchema>;

const COLUMNS = `session_id AS "sessionId", kind, due_at AS "dueAt"`;

/** Sets (or moves) the session's timer of this kind. */
export async function upsertTimer(db: Queryable, timer: Timer): Promise<Timer> {
  const { rows } = await db.query(
    `INSERT INTO timers (session_id, kind, due_at) VALUES ($1, $2, $3)
     ON CONFLICT (session_id, kind) DO UPDATE SET due_at = EXCLUDED.due_at
     RETURNING ${COLUMNS}`,
    [timer.sessionId, timer.kind, timer.dueAt],
  );
  return parseReturnedRow("timers", timerSchema, rows);
}

/** Removes the timer; true if one existed. */
export async function deleteTimer(db: Queryable, sessionId: string, kind: TimerKind): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM timers WHERE session_id = $1 AND kind = $2", [sessionId, kind]);
  return rowCount === 1;
}

export async function listTimers(db: Queryable, sessionId: string): Promise<Timer[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM timers WHERE session_id = $1 ORDER BY due_at, kind`, [sessionId]);
  return parseRows("timers", timerSchema, rows);
}

/** The earliest due time across all sessions (null when there are no timers); the sweeper sleeps until it. */
export async function earliestTimerDueAt(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ dueAt: unknown }>(`SELECT min(due_at) AS "dueAt" FROM timers`);
  return timestamp.nullable().parse(rows[0]?.dueAt ?? null);
}

/**
 * Locks and returns timers due at `now`, earliest first. Rows another transaction has claimed are skipped
 * (FOR UPDATE SKIP LOCKED), so concurrent claimers, also in different processes, never get the same timer.
 * The claim lasts until the transaction ends.
 */
export async function claimDueTimers(tx: Tx, options: { now: Date; limit: number }): Promise<Timer[]> {
  const { rows } = await tx.query(
    `SELECT ${COLUMNS} FROM timers WHERE due_at <= $1 ORDER BY due_at, session_id, kind LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [options.now, checkLimit(options.limit)],
  );
  return parseRows("timers", timerSchema, rows);
}
