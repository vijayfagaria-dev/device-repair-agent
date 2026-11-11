// field_candidates: every value ever offered for a field (D11, D15). Append-only: a correction is a new row.
import { FieldSource } from "@device-repair/shared/protocol";
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { bigintId, int, json, type JsonValue, parseReturnedRow, parseRows, timestamp, toJsonParam, toOptionalJsonParam } from "./rows.js";

export const CANDIDATE_STATUSES = ["valid", "invalid", "skipped", "unverified"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

const candidateSchema = z.object({
  id: bigintId,
  sessionId: z.string(),
  eventSeq: int,
  field: z.string(),
  source: z.enum(FieldSource),
  raw: json,
  normalized: json.nullable(),
  status: z.enum(CANDIDATE_STATUSES),
  error: z.string().nullable(),
  userConfirmed: z.boolean(),
  collectedAt: timestamp,
  evidence: z.string().nullable(),
});
export type FieldCandidate = z.infer<typeof candidateSchema>;

export interface NewFieldCandidate {
  sessionId: string;
  /** The event that introduced the value; it may be appended later in the same transaction (deferred FK). */
  eventSeq: number;
  field: string;
  source: FieldSource;
  raw: JsonValue;
  normalized?: JsonValue | null;
  status: CandidateStatus;
  error?: string | null;
  userConfirmed?: boolean;
  collectedAt?: Date;
  evidence?: string | null;
}

const COLUMNS = `id, session_id AS "sessionId", event_seq AS "eventSeq", field, source, raw, normalized, status, error,
  user_confirmed AS "userConfirmed", collected_at AS "collectedAt", evidence`;

export async function insertFieldCandidate(db: Queryable, candidate: NewFieldCandidate): Promise<FieldCandidate> {
  const { rows } = await db.query(
    `INSERT INTO field_candidates
       (session_id, event_seq, field, source, raw, normalized, status, error, user_confirmed, collected_at, evidence)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, COALESCE($10::timestamptz, now()), $11)
     RETURNING ${COLUMNS}`,
    [
      candidate.sessionId,
      candidate.eventSeq,
      candidate.field,
      candidate.source,
      toJsonParam(candidate.raw),
      toOptionalJsonParam(candidate.normalized),
      candidate.status,
      candidate.error ?? null,
      candidate.userConfirmed ?? false,
      candidate.collectedAt ?? null,
      candidate.evidence ?? null,
    ],
  );
  return parseReturnedRow("field_candidates", candidateSchema, rows);
}

/** Candidates in insertion order: all fields, or one field. */
export async function listFieldCandidates(db: Queryable, sessionId: string, field?: string): Promise<FieldCandidate[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM field_candidates WHERE session_id = $1 AND ($2::text IS NULL OR field = $2) ORDER BY id`,
    [sessionId, field ?? null],
  );
  return parseRows("field_candidates", candidateSchema, rows);
}
