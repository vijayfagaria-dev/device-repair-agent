// The call engine's view of its session (P5): commands through the processor, a fresh read of the state for each
// LLM call, the hub for chat events, and the usage ledger and turn metrics. The production port is below; tests can
// fake it. Ledger and metric writes never fail the call: an error is logged.
import type { RecordFieldId } from "@device-repair/shared/fields";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { listFieldCandidates } from "../db/repos/fieldCandidates.js";
import { listInputRequests, type StoredInputRequest } from "../db/repos/inputRequests.js";
import { getSession, type Session } from "../db/repos/sessions.js";
import { upsertTurnMetric, type TurnMetricUpdate } from "../db/repos/turnMetrics.js";
import type { ResolvedField } from "../domain/conflicts.js";
import { recordLlmUsage, recordUsage } from "../metrics/usage.js";
import type { Command, CommandProcessor } from "../session/commands.js";
import type { SessionHub, SessionUpdate } from "../session/hub.js";
import { resolveFields } from "../session/snapshot.js";
import type { LlmRoute, LlmUsage } from "./types.js";

export interface CallContext {
  session: Session;
  fields: Record<RecordFieldId, ResolvedField>;
  requests: StoredInputRequest[];
  /** The last thing the agent said on an earlier call of this session (a returning call's summary, P5-T12). */
  lastAgentLineBefore: string | null;
}

export interface CallSessionPort {
  readonly sessionId: string;
  dispatch<R>(command: Command & Record<string, unknown>): Promise<R | undefined>;
  context(callId: string): Promise<CallContext>;
  subscribe(listener: (update: SessionUpdate) => void): () => void;
  /** Runs the planner now (the 60 s safety net needs no other command to happen, P4 review #9). */
  reconcile(): Promise<void>;
  recordLlmUsage(route: LlmRoute, usage: LlmUsage): Promise<void>;
  /** A model call that ended before the provider reported usage (aborted): counted as a request (quota guard). */
  recordLlmRequest(route: LlmRoute): Promise<void>;
  recordSttSeconds(seconds: number): Promise<void>;
  recordTtsCharacters(characters: number): Promise<void>;
  recordTurnMetric(metric: Omit<TurnMetricUpdate, "sessionId">): Promise<void>;
}

export function createCallSessionPort(options: { pool: pg.Pool; processor: CommandProcessor; hub: SessionHub; sessionId: string; log: FastifyBaseLogger }): CallSessionPort {
  const { pool, processor, hub, sessionId, log } = options;
  const quietly = async (what: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (err) {
      log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, `${what} failed`);
    }
  };
  return {
    sessionId,
    async dispatch<R>(command: Command & Record<string, unknown>) {
      return (await processor.dispatch<R>(sessionId, command)).reply;
    },
    async context(callId) {
      const [session, candidates, requests, last] = await Promise.all([
        getSession(pool, sessionId),
        listFieldCandidates(pool, sessionId),
        listInputRequests(pool, sessionId),
        pool.query<{ text: string }>(
          "SELECT text FROM transcript_lines WHERE session_id = $1 AND role = 'agent' AND call_id <> $2 ORDER BY event_seq DESC LIMIT 1",
          [sessionId, callId],
        ),
      ]);
      if (!session) throw new Error("session not found");
      return { session, fields: resolveFields(candidates), requests, lastAgentLineBefore: last.rows[0]?.text ?? null };
    },
    subscribe: (listener) => hub.subscribe(sessionId, listener),
    reconcile: () => processor.react(sessionId),
    recordLlmUsage: (route, usage) =>
      quietly("LLM usage", () =>
        recordLlmUsage(pool, { sessionId, provider: route.provider, model: route.model, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cachedTokens: Math.min(usage.cachedTokens, usage.promptTokens) }),
      ),
    recordLlmRequest: (route) => quietly("LLM request", () => recordUsage(pool, { sessionId, provider: route.provider, kind: `${route.model}:requests`, units: 1 })),
    recordSttSeconds: (seconds) => quietly("STT usage", () => (seconds > 0 ? recordUsage(pool, { sessionId, provider: "deepgram", kind: "nova-3:audio", units: seconds }) : Promise.resolve())),
    recordTtsCharacters: (characters) =>
      quietly("TTS usage", () => (characters > 0 ? recordUsage(pool, { sessionId, provider: "deepgram", kind: "aura-2:characters", units: characters }) : Promise.resolve())),
    recordTurnMetric: (metric) => quietly("turn metric", () => upsertTurnMetric(pool, { ...metric, sessionId })),
  };
}
