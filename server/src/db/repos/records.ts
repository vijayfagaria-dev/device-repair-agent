// records: immutable record revisions (D17). Append-only (trigger); a new revision is a new row.
import { Outcome } from "@device-repair/shared/protocol";
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, jsonObject, type JsonObject, parseOptionalRow, parseReturnedRow, parseRows, timestamp, toJsonParam } from "./rows.js";

const recordSchema = z.object({
  sessionId: z.string(),
  revision: int,
  outcome: z.enum(Outcome),
  payload: jsonObject,
  contentHash: z.string(),
  createdAt: timestamp,
});
export type StoredRecord = z.infer<typeof recordSchema>;

export interface NewRecord {
  sessionId: string;
  revision: number;
  outcome: Outcome;
  payload: JsonObject;
  /** Lowercase hex SHA-256 (D17 content hash). */
  contentHash: string;
}

const COLUMNS = `session_id AS "sessionId", revision, outcome, payload, content_hash AS "contentHash", created_at AS "createdAt"`;

/** Fails with 23505 (records_session_revision_key) if the revision already exists. */
export async function insertRecord(db: Queryable, record: NewRecord): Promise<StoredRecord> {
  const { rows } = await db.query(
    `INSERT INTO records (session_id, revision, outcome, payload, content_hash) VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${COLUMNS}`,
    [record.sessionId, record.revision, record.outcome, toJsonParam(record.payload), record.contentHash],
  );
  return parseReturnedRow("records", recordSchema, rows);
}

export async function getRecord(db: Queryable, sessionId: string, revision: number): Promise<StoredRecord | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM records WHERE session_id = $1 AND revision = $2`, [sessionId, revision]);
  return parseOptionalRow("records", recordSchema, rows);
}

export async function getLatestRecord(db: Queryable, sessionId: string): Promise<StoredRecord | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM records WHERE session_id = $1 ORDER BY revision DESC LIMIT 1`, [
    sessionId,
  ]);
  return parseOptionalRow("records", recordSchema, rows);
}

/** The latest revision's number and content hash, without its payload (the dedup check, D17). */
export async function getLatestRevisionHash(db: Queryable, sessionId: string): Promise<{ revision: number; contentHash: string } | null> {
  const { rows } = await db.query<{ revision: number; contentHash: string }>(
    `SELECT revision, content_hash AS "contentHash" FROM records WHERE session_id = $1 ORDER BY revision DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ? { revision: Number(rows[0].revision), contentHash: rows[0].contentHash } : null;
}

export async function listRecords(db: Queryable, sessionId: string): Promise<StoredRecord[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM records WHERE session_id = $1 ORDER BY revision`, [sessionId]);
  return parseRows("records", recordSchema, rows);
}
