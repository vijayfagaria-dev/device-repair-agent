// Latency measurement helpers (P11-T02, D20): the per-turn row. Pure functions: no clock, no database.
// (The summary statistics live in scripts/report.ts, which runs without a build.)
import type { TurnMetricUpdate } from "../db/repos/turnMetrics.js";

/** The agent turn id the call engine mints (`ta_<callId>_<n>`); the client echoes it in `clientMetric`. */
const AGENT_TURN_ID = /^ta_(.+)_\d+$/;

/** The call a turn id belongs to, or null when it isn't an agent turn id. */
export function callIdOfTurn(turnId: string): string | null {
  return AGENT_TURN_ID.exec(turnId)?.[1] ?? null;
}

export interface TurnFacts {
  turnId: string;
  callId: string;
  /** Epoch ms: STT's end-of-utterance event, when the reply follows a user utterance. */
  userEndAt: number | null;
  /** Epoch ms: the first TTS audio frame written to the socket. */
  firstAudioAt: number | null;
  /** Wait between STT's end-of-utterance event and the turn being handed to the agent (the merge window). */
  sttMs?: number | null;
  llmTtftMs?: number | null;
  ttsTtfbMs?: number | null;
}

const whole = (ms: number) => Math.max(0, Math.round(ms));

/**
 * The `turn_metrics` update for one agent turn, or null when there is nothing to record (a turn with neither a user
 * utterance before it nor any audio). `serverMs` = user end → first audio; it needs both ends.
 */
export function buildTurnMetric(facts: TurnFacts): Omit<TurnMetricUpdate, "sessionId"> | null {
  if (facts.userEndAt === null && facts.firstAudioAt === null) return null;
  return {
    turnId: facts.turnId,
    callId: facts.callId,
    ...(facts.userEndAt !== null ? { userEndAt: new Date(facts.userEndAt) } : {}),
    ...(facts.firstAudioAt !== null ? { firstAudioAt: new Date(facts.firstAudioAt) } : {}),
    ...(facts.userEndAt !== null && facts.firstAudioAt !== null ? { serverMs: whole(facts.firstAudioAt - facts.userEndAt) } : {}),
    ...(facts.userEndAt !== null && facts.sttMs != null ? { sttMs: whole(facts.sttMs) } : {}),
    ...(facts.llmTtftMs != null ? { llmTtftMs: whole(facts.llmTtftMs) } : {}),
    ...(facts.ttsTtfbMs != null ? { ttsTtfbMs: whole(facts.ttsTtfbMs) } : {}),
  };
}
