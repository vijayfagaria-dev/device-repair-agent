// WS /call (P5-T02; protocol.md §3.1–§3.2, §6). Replaces the P1 echo.
//
// Handshake as /chat (Origin, session id, lazy creation), then: a closed session → 4410; the per-instance call cap →
// 4429 capacity; StartCall (one active call per session, D11) → 4409 for a second one. Then a CallEngine runs the
// call. Mic frames must be exactly 640 bytes (others are dropped and counted), messages over 4 KB close with 1009,
// and a 15 s pong timeout catches half-open connections. Every way the socket closes ends the call exactly once
// (EndCall): the user hanging up, the tab closing or the network dropping (by close code), server shutdown (1012),
// or the engine itself (agent ended, silence, max duration, provider error).
import { randomBytes } from "node:crypto";
import { CloseCode, MIC_FRAME_BYTES } from "@device-repair/shared/protocol";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type { CommandProcessor } from "../session/commands.js";
import type { CallEndReason, EndCall, StartCall, StartCallReply } from "../session/handlers/call.js";
import type { SessionHub } from "../session/hub.js";
import type { BargeInSettings } from "../voice/bargeIn.js";
import { CallEngine, type CallTimings } from "../voice/callEngine.js";
import { createCallSessionPort } from "../voice/callSession.js";
import { type Clock, realClock } from "../voice/clock.js";
import type { LlmClient, SttProvider, TtsProvider } from "../voice/types.js";
import { isProviderRefusal, type QuotaGuard } from "../limits/quotaGuard.js";
import { acceptSessionSocket, type SocketDeps } from "./handshake.js";
import type { KeepAliveOptions } from "./keepAlive.js";
import { closeWithNotice } from "./closing.js";

/** protocol.md §7: /call messages are at most 4 KB (the shared server limit is /chat's). */
export const MAX_CALL_MESSAGE_BYTES = 4 * 1024;
/** protocol.md §7: a 15 s pong timeout on /call (pings at 5 s and 10 s unanswered → terminated at 15 s). */
export const CALL_KEEPALIVE: KeepAliveOptions = { intervalMs: 5_000, maxMissed: 2 };
/** Mic frames are 20 ms each, so a real mic sends 50 a second; a 2 s burst allows for network jitter (P5 review #12). */
export const MAX_FRAMES_PER_SECOND = 50;
export const MAX_FRAME_BURST = 100;

export interface VoiceDeps {
  /** The providers for one call (real Deepgram/Groq in production, fakes in tests). */
  providers(): { stt: SttProvider; tts: TtsProvider; llm: LlmClient };
  /** MAX_CONCURRENT_CALLS: calls this instance runs at once (free-tier rate limits, P0-T03: starts at 1). */
  maxConcurrentCalls: number;
  clock?: Clock;
  timings?: Partial<CallTimings>;
  bargeIn?: BargeInSettings;
  /** The /call keepalive (default CALL_KEEPALIVE; tests shorten it). */
  keepAlive?: KeepAliveOptions;
  /** The free-tier quota guard (P10-T03): a new call is refused with 4429 `quota` while it says no. */
  quota?: QuotaGuard;
}

export interface CallSocketDeps extends SocketDeps {
  hub: SessionHub;
  processor: CommandProcessor;
  /** Null: voice isn't configured, and /call refuses with 1011. */
  voice: VoiceDeps | null;
}

/** Why the call ended, from how the socket closed (when the engine didn't end it itself). */
export function endReasonFor(code: number): CallEndReason {
  if (code === CloseCode.SERVER_RESTARTING) return "server_restart";
  // 1000 normal, 1001 going away (tab closed), 1005 no status: the user ended it.
  if (code === 1000 || code === 1001 || code === 1005) return "hangup";
  return "network"; // 1006 (dropped, or terminated after missed pongs) and anything else
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/** The calls running on this instance (for the cap, shutdown and tests). */
export class ActiveCalls {
  readonly engines = new Set<CallEngine>();
  get size(): number {
    return this.engines.size;
  }
  /** Resolves when every call has ended. */
  async settled(): Promise<void> {
    await Promise.all([...this.engines].map((engine) => engine.whenEnded));
  }
}

export async function callSocketRoutes(app: FastifyInstance, deps: CallSocketDeps): Promise<ActiveCalls> {
  const active = new ActiveCalls();
  // Calls being set up count against the cap too (two connects at once can't both slip under it).
  let starting = 0;
  // Sessions with a call running or being set up. A second connect for the same session is refused as "already
  // active" before the capacity check: with a cap of 1 the caller's own live call would otherwise make the refusal
  // read "voice is busy" (live report, 2026-11-11), which is untrue and hides that the call is still running.
  const sessionsInCall = new Set<string>();
  const callDeps: SocketDeps = { ...deps, keepAlive: deps.voice?.keepAlive ?? CALL_KEEPALIVE };

  app.route({
    method: "GET",
    url: "/call",
    handler: (_request, reply) => reply.callNotFound(),
    wsHandler: async (socket, request) => {
      const accepted = await acceptSessionSocket(socket, request, callDeps, "call");
      if (!accepted) return;
      const { session, log } = accepted;
      const voice = deps.voice;
      if (!voice) {
        log.error("call refused: voice is not configured");
        closeWithNotice(socket, CloseCode.SERVER_ERROR, "server error");
        return;
      }
      if (session.status === "closed") {
        closeWithNotice(socket, CloseCode.SESSION_CLOSED, "session closed");
        return;
      }
      // Before the capacity check, which must stay synchronous with `starting += 1` (the guard's read is async).
      const quota = await voice.quota?.check();
      if (quota && !quota.ok) {
        log.warn({ reason: quota.reason }, "call refused: quota");
        closeWithNotice(socket, CloseCode.RATE_LIMITED, "quota");
        return;
      }
      if (socket.readyState !== socket.OPEN) return;
      if (sessionsInCall.has(session.id)) {
        log.warn("call refused: this session already has a call");
        closeWithNotice(socket, CloseCode.CALL_ALREADY_ACTIVE, "call already active");
        return;
      }
      if (active.size + starting >= voice.maxConcurrentCalls) {
        log.warn({ active: active.size, max: voice.maxConcurrentCalls }, "call refused: capacity");
        closeWithNotice(socket, CloseCode.RATE_LIMITED, "capacity");
        return;
      }
      starting += 1;
      sessionsInCall.add(session.id);
      let started = false;
      const callId = `c${randomBytes(9).toString("base64url").replace(/_/g, "-")}`;
      let engine: CallEngine;
      // The socket can close at any point, also while the providers are still opening: keep its close code, so the
      // call ends with the right reason whenever the engine is ready (a hang-up in the first second isn't "network").
      let closeCode: number | null = null;
      let onClosed: ((code: number) => void) | null = null;
      socket.once("close", (code) => {
        closeCode = code;
        onClosed?.(code);
      });
      try {
        const { reply } = await deps.processor.dispatch<StartCallReply>(session.id, { type: "StartCall", callId } as StartCall);
        if (reply?.status === "refused") {
          const [code, why] =
            reply.reason === "closed"
              ? [CloseCode.SESSION_CLOSED, "session closed"]
              : reply.reason === "resumeRequired"
                ? [CloseCode.RESUME_REQUIRED, "resume required"]
                : [CloseCode.CALL_ALREADY_ACTIVE, "call already active"];
          closeWithNotice(socket, code, why);
          return;
        }
        if (closeCode !== null) {
          // Gone during StartCall: the call that just started ends at once, for the reason it closed.
          await deps.processor.dispatch(session.id, { type: "EndCall", callId, reason: endReasonFor(closeCode) } as EndCall);
          return;
        }
        const callLog = log.child({ callId });
        engine = await CallEngine.start({
          callId,
          port: createCallSessionPort({ pool: deps.pool, processor: deps.processor, hub: deps.hub, sessionId: session.id, log: callLog }),
          ...voice.providers(),
          clock: voice.clock ?? realClock,
          log: callLog,
          returning: reply?.status === "started" && reply.returning,
          timings: voice.timings,
          bargeIn: voice.bargeIn,
          send: (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
          },
          close: (code, reason) => {
            if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) closeWithNotice(socket, code, reason);
          },
        });
        started = true;
      } catch (err) {
        // The engine closes the socket itself when a provider fails; anything else (StartCall's database) is 1011.
        log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "call failed to start");
        // Deepgram refusing the key or the credit (401/402/403) won't fix itself: stop trying for a while.
        if (isProviderRefusal(err)) voice.quota?.providerRefused("deepgram");
        if (socket.readyState === socket.OPEN) closeWithNotice(socket, CloseCode.SERVER_ERROR, "server error");
        return;
      } finally {
        starting -= 1;
        if (!started) sessionsInCall.delete(session.id);
      }

      active.engines.add(engine);
      void engine.whenEnded.then(() => {
        active.engines.delete(engine);
        sessionsInCall.delete(session.id);
      });
      const stop = (code: number) => void engine.stop(endReasonFor(code)).finally(() => active.engines.delete(engine));
      if (closeCode !== null) {
        stop(closeCode);
        return;
      }
      onClosed = stop;

      let dropped = 0;
      // Faster than real time isn't a mic: frames beyond the rate are dropped, not sent to (and billed by) the STT.
      let tokens = MAX_FRAME_BURST;
      let refilledAt = Date.now();
      accepted.onMessage((data, isBinary) => {
        const bytes = toBuffer(data);
        if (bytes.length > MAX_CALL_MESSAGE_BYTES) {
          closeWithNotice(socket, CloseCode.MESSAGE_TOO_BIG, "message too big");
          return;
        }
        // Text frames are reserved (P13); a binary frame of any other length isn't mic audio.
        if (!isBinary || bytes.length !== MIC_FRAME_BYTES) {
          dropped += 1;
          if (dropped === 1 || dropped % 500 === 0) log.debug({ dropped }, "call frames dropped");
          return;
        }
        const now = Date.now();
        tokens = Math.min(MAX_FRAME_BURST, tokens + ((now - refilledAt) * MAX_FRAMES_PER_SECOND) / 1000);
        refilledAt = now;
        if (tokens < 1) {
          dropped += 1;
          if (dropped % 500 === 1) log.warn({ dropped }, "call frames dropped: faster than real time");
          return;
        }
        tokens -= 1;
        engine.pushAudio(bytes);
      });
    },
  });
  return active;
}
