// transcript_lines: final transcript lines of a call (interim text is never stored).
import { Role } from "@device-repair/shared/protocol";
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, parseReturnedRow, parseRows, timestamp } from "./rows.js";

const transcriptLineSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  callId: z.string(),
  eventSeq: int,
  role: z.enum(Role),
  text: z.string(),
  interrupted: z.boolean(),
  startedAt: timestamp,
});
export type TranscriptLine = z.infer<typeof transcriptLineSchema>;

export interface NewTranscriptLine {
  id: string;
  sessionId: string;
  callId: string;
  /** The transcript event; it may be appended later in the same transaction (deferred FK). */
  eventSeq: number;
  role: Role;
  text: string;
  interrupted?: boolean;
  startedAt: Date;
}

const COLUMNS = `id, session_id AS "sessionId", call_id AS "callId", event_seq AS "eventSeq", role, text, interrupted,
  started_at AS "startedAt"`;

export async function insertTranscriptLine(db: Queryable, line: NewTranscriptLine): Promise<TranscriptLine> {
  const { rows } = await db.query(
    `INSERT INTO transcript_lines (id, session_id, call_id, event_seq, role, text, interrupted, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [line.id, line.sessionId, line.callId, line.eventSeq, line.role, line.text, line.interrupted ?? false, line.startedAt],
  );
  return parseReturnedRow("transcript_lines", transcriptLineSchema, rows);
}

/** Lines of all of the session's calls, in event order (the replay order). */
export async function listTranscriptLines(db: Queryable, sessionId: string): Promise<TranscriptLine[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM transcript_lines WHERE session_id = $1 ORDER BY event_seq, id`, [
    sessionId,
  ]);
  return parseRows("transcript_lines", transcriptLineSchema, rows);
}
