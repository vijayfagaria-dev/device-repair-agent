// outbox: one delivery row per record revision and target (D17), written in the record's transaction.
// Delivery policy (backoff, leases, per-session ordering, dead-lettering) belongs to the worker (P7-T03).
import { z } from "zod";
import type { Queryable, Tx } from "../tx.js";
import { bigintId, checkLimit, int, parseOptionalRow, parseReturnedRow, parseRows, timestamp } from "./rows.js";

/** The one delivery target: the configured record webhook (RECORD_WEBHOOK_URL, D17). */
export const WEBHOOK_TARGET = "webhook";

export const OUTBOX_STATUSES = ["pending", "sending", "delivered", "dead"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

const outboxSchema = z.object({
  id: bigintId,
  sessionId: z.string(),
  revision: int,
  target: z.string(),
  status: z.enum(OUTBOX_STATUSES),
  attempts: int,
  nextAttemptAt: timestamp,
  lastError: z.string().nullable(),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});
export type OutboxEntry = z.infer<typeof outboxSchema>;

export interface OutboxUpdate {
  id: number;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  deliveredAt: Date | null;
}

const COLUMNS = `id, session_id AS "sessionId", revision, target, status, attempts, next_attempt_at AS "nextAttemptAt",
  last_error AS "lastError", created_at AS "createdAt", delivered_at AS "deliveredAt"`;

/** Queues a delivery. Fails with 23503 if the record revision doesn't exist, 23505 if it is already queued. */
export async function insertOutbox(
  db: Queryable,
  entry: { sessionId: string; revision: number; target: string; nextAttemptAt?: Date },
): Promise<OutboxEntry> {
  const { rows } = await db.query(
    `INSERT INTO outbox (session_id, revision, target, next_attempt_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
     RETURNING ${COLUMNS}`,
    [entry.sessionId, entry.revision, entry.target, entry.nextAttemptAt ?? null],
  );
  return parseReturnedRow("outbox", outboxSchema, rows);
}

/**
 * Deliverable = not finished, and no earlier revision of the same session and target is still unfinished (D17: rev n+1
 * waits until rev n is delivered or dead, so a consumer never sees an older revision after a newer one). `sending`
 * counts as unfinished, so a revision leased by one worker holds back the next one for every worker.
 */
const DELIVERABLE = `outbox.status IN ('pending', 'sending')
  AND NOT EXISTS (
    SELECT 1 FROM outbox earlier
    WHERE earlier.session_id = outbox.session_id AND earlier.target = outbox.target
      AND earlier.revision < outbox.revision AND earlier.status IN ('pending', 'sending')
  )`;

/**
 * Locks and returns deliverable rows (see above) that are due at `now`, oldest due first. A `sending` row whose lease
 * (its next attempt time) has passed is due again. FOR UPDATE SKIP LOCKED: concurrent claimers never get the same
 * row. The claim lasts until the transaction ends.
 */
export async function claimDueOutbox(tx: Tx, options: { now: Date; limit: number }): Promise<OutboxEntry[]> {
  const { rows } = await tx.query(
    `SELECT ${COLUMNS} FROM outbox
     WHERE ${DELIVERABLE} AND next_attempt_at <= $1
     ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [options.now, checkLimit(options.limit)],
  );
  return parseRows("outbox", outboxSchema, rows);
}

/**
 * Boot recovery (P8-T01): every row a previous process left `sending` goes back to `pending`, due now. A lease normally
 * expires by itself, but a restarted process shouldn't wait for it. If an old instance is still alive during a
 * deploy overlap it may deliver the same row too: harmless, because the receiver stores an idempotency key once.
 */
export async function reclaimOutboxLeases(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(`UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE status = 'sending'`);
  return rowCount ?? 0;
}

/** When the next deliverable row is due (null for none): the worker sleeps until then (D09: no polling). */
export async function earliestOutboxDueAt(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ due: Date | null }>(`SELECT min(next_attempt_at) AS due FROM outbox WHERE ${DELIVERABLE}`);
  return rows[0]?.due ?? null;
}

/** Writes the delivery state. Returns the stored row, or null if there is no such row. */
export async function saveOutbox(db: Queryable, update: OutboxUpdate): Promise<OutboxEntry | null> {
  const { rows } = await db.query(
    `UPDATE outbox SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, delivered_at = $6 WHERE id = $1
     RETURNING ${COLUMNS}`,
    [update.id, update.status, update.attempts, update.nextAttemptAt, update.lastError, update.deliveredAt],
  );
  return parseOptionalRow("outbox", outboxSchema, rows);
}

export async function listOutbox(db: Queryable, sessionId: string): Promise<OutboxEntry[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM outbox WHERE session_id = $1 ORDER BY revision, target`, [sessionId]);
  return parseRows("outbox", outboxSchema, rows);
}
