// input_requests: chat input cards (D13). At most one open card per session (partial unique index).
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, jsonObject, type JsonObject, parseOptionalRow, parseReturnedRow, parseRows, timestamp, toJsonParam } from "./rows.js";

export const INPUT_REQUEST_STATUSES = ["queued", "open", "answered", "cancelled"] as const;
export type InputRequestStatus = (typeof INPUT_REQUEST_STATUSES)[number];

const inputRequestSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
  field: z.string(),
  spec: jsonObject,
  status: z.enum(INPUT_REQUEST_STATUSES),
  attempts: int,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StoredInputRequest = z.infer<typeof inputRequestSchema>;

export interface NewInputRequest {
  sessionId: string;
  id: string;
  field: string;
  spec: JsonObject;
  status?: InputRequestStatus;
}

const COLUMNS = `session_id AS "sessionId", id, field, spec, status, attempts, created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export async function insertInputRequest(db: Queryable, request: NewInputRequest): Promise<StoredInputRequest> {
  const { rows } = await db.query(
    `INSERT INTO input_requests (session_id, id, field, spec, status) VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${COLUMNS}`,
    [request.sessionId, request.id, request.field, toJsonParam(request.spec), request.status ?? "queued"],
  );
  return parseReturnedRow("input_requests", inputRequestSchema, rows);
}

export async function getInputRequest(db: Queryable, sessionId: string, id: string): Promise<StoredInputRequest | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM input_requests WHERE session_id = $1 AND id = $2`, [sessionId, id]);
  return parseOptionalRow("input_requests", inputRequestSchema, rows);
}

export async function getOpenInputRequest(db: Queryable, sessionId: string): Promise<StoredInputRequest | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM input_requests WHERE session_id = $1 AND status = 'open'`, [sessionId]);
  return parseOptionalRow("input_requests", inputRequestSchema, rows);
}

export async function listInputRequests(db: Queryable, sessionId: string): Promise<StoredInputRequest[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM input_requests WHERE session_id = $1 ORDER BY created_at, id`, [
    sessionId,
  ]);
  return parseRows("input_requests", inputRequestSchema, rows);
}

/** Updates status and attempts (and updated_at). Returns the stored row, or null if there is no such request. */
export async function saveInputRequest(
  db: Queryable,
  request: { sessionId: string; id: string; status: InputRequestStatus; attempts: number },
): Promise<StoredInputRequest | null> {
  const { rows } = await db.query(
    `UPDATE input_requests SET status = $3, attempts = $4, updated_at = now() WHERE session_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [request.sessionId, request.id, request.status, request.attempts],
  );
  return parseOptionalRow("input_requests", inputRequestSchema, rows);
}
