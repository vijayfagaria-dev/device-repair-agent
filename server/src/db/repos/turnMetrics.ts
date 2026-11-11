// turn_metrics: per-turn latency (D19). Stages arrive at different times (client_ms last, via clientMetric),
// so writes merge into the row: a stage that is already recorded is kept unless a new value is given.
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, parseOptionalRow, parseRows, timestamp } from "./rows.js";

const turnMetricSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  callId: z.string(),
  userEndAt: timestamp.nullable(),
  firstAudioAt: timestamp.nullable(),
  serverMs: int.nullable(),
  clientMs: int.nullable(),
  sttMs: int.nullable(),
  llmTtftMs: int.nullable(),
  ttsTtfbMs: int.nullable(),
});
export type TurnMetric = z.infer<typeof turnMetricSchema>;

export interface TurnMetricUpdate {
  turnId: string;
  sessionId: string;
  callId: string;
  userEndAt?: Date;
  firstAudioAt?: Date;
  serverMs?: number;
  clientMs?: number;
  sttMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
}

const COLUMNS = `turn_id AS "turnId", session_id AS "sessionId", call_id AS "callId", user_end_at AS "userEndAt",
  first_audio_at AS "firstAudioAt", server_ms AS "serverMs", client_ms AS "clientMs", stt_ms AS "sttMs",
  llm_ttft_ms AS "llmTtftMs", tts_ttfb_ms AS "ttsTtfbMs"`;

/**
 * Inserts the turn or merges the given stages into it. Returns null, changing nothing, when the turn id belongs to
 * a different session or call (a client can't write metrics into someone else's turn).
 */
export async function upsertTurnMetric(db: Queryable, metric: TurnMetricUpdate): Promise<TurnMetric | null> {
  const { rows } = await db.query(
    `INSERT INTO turn_metrics
       (turn_id, session_id, call_id, user_end_at, first_audio_at, server_ms, client_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (turn_id) DO UPDATE SET
       user_end_at    = COALESCE(EXCLUDED.user_end_at, turn_metrics.user_end_at),
       first_audio_at = COALESCE(EXCLUDED.first_audio_at, turn_metrics.first_audio_at),
       server_ms      = COALESCE(EXCLUDED.server_ms, turn_metrics.server_ms),
       client_ms      = COALESCE(EXCLUDED.client_ms, turn_metrics.client_ms),
       stt_ms         = COALESCE(EXCLUDED.stt_ms, turn_metrics.stt_ms),
       llm_ttft_ms    = COALESCE(EXCLUDED.llm_ttft_ms, turn_metrics.llm_ttft_ms),
       tts_ttfb_ms    = COALESCE(EXCLUDED.tts_ttfb_ms, turn_metrics.tts_ttfb_ms)
     WHERE turn_metrics.session_id = EXCLUDED.session_id AND turn_metrics.call_id = EXCLUDED.call_id
     RETURNING ${COLUMNS}`,
    [
      metric.turnId,
      metric.sessionId,
      metric.callId,
      metric.userEndAt ?? null,
      metric.firstAudioAt ?? null,
      metric.serverMs ?? null,
      metric.clientMs ?? null,
      metric.sttMs ?? null,
      metric.llmTtftMs ?? null,
      metric.ttsTtfbMs ?? null,
    ],
  );
  return parseOptionalRow("turn_metrics", turnMetricSchema, rows);
}

export async function listTurnMetrics(db: Queryable, sessionId: string): Promise<TurnMetric[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM turn_metrics WHERE session_id = $1 ORDER BY user_end_at NULLS LAST, turn_id`,
    [sessionId],
  );
  return parseRows("turn_metrics", turnMetricSchema, rows);
}
