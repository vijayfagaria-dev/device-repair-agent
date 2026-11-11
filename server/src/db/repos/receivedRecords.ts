// received_records: the stub receiver's dedup table (P7-T04). The same Idempotency-Key is stored once.
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, json, type JsonValue, parseReturnedRow, parseRows, timestamp, toJsonParam } from "./rows.js";

const receivedRecordSchema = z.object({
  idempotencyKey: z.string(),
  payload: json,
  firstReceivedAt: timestamp,
  lastReceivedAt: timestamp,
  timesReceived: int,
});
export type ReceivedRecord = z.infer<typeof receivedRecordSchema>;

const COLUMNS = `idempotency_key AS "idempotencyKey", payload, first_received_at AS "firstReceivedAt",
  last_received_at AS "lastReceivedAt", times_received AS "timesReceived"`;

/** Stores the first delivery of a key; a repeat only bumps the counter and last time (the first payload is kept). */
export async function upsertReceivedRecord(db: Queryable, delivery: { idempotencyKey: string; payload: JsonValue }): Promise<ReceivedRecord> {
  const { rows } = await db.query(
    `INSERT INTO received_records (idempotency_key, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       times_received = received_records.times_received + 1,
       last_received_at = now()
     RETURNING ${COLUMNS}`,
    [delivery.idempotencyKey, toJsonParam(delivery.payload)],
  );
  return parseReturnedRow("received_records", receivedRecordSchema, rows);
}

export async function listReceivedRecords(db: Queryable): Promise<ReceivedRecord[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM received_records ORDER BY first_received_at, idempotency_key`);
  return parseRows("received_records", receivedRecordSchema, rows);
}
