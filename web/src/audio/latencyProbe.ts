// Client-side perceived latency (P11-T02, D20): from the moment the user stopped speaking to the moment the agent's
// first audio is *scheduled to play*. A secondary number, reported separately from the server's: it hears the room,
// so an echo from speakers (no headphones) or a noisy mic can fake a speech end. It is only a sample; the server joins
// it to the turn by id and the report says how it was taken.
import { ChatClientMessageType, type ClientMetric } from "@device-repair/shared/protocol";

/** Mic RMS (0..1) at or above this counts as speech. */
export const SPEECH_LEVEL = 0.02;
/** The speech has ended once the level stays below SPEECH_LEVEL this long (protocol: "≥ 300 ms"). */
export const QUIET_MS = 300;
/** Shorter bursts (a click, a cough) are not an utterance. */
export const MIN_SPEECH_MS = 200;
/** A speech end the agent never answered goes stale: a later proactive turn is not a reply to it. */
export const MARK_TTL_MS = 15_000;
/** protocol.md §3.4: other values are dropped by the server. */
const MAX_MS = 60_000;

export class LatencyProbe {
  readonly #send: (metric: ClientMetric) => void;
  #speechStartedAt: number | null = null;
  #quietSince: number | null = null;
  /** When the user's last utterance ended (the start of the quiet), once the quiet lasted QUIET_MS. */
  #speechEndAt: number | null = null;
  #turnId: string | null = null;

  constructor(send: (metric: ClientMetric) => void) {
    this.#send = send;
  }

  /** One mic frame's level, with the time it was captured (ms, a monotonic clock). */
  onMicLevel(level: number, now: number): void {
    if (level >= SPEECH_LEVEL) {
      this.#speechStartedAt ??= now;
      this.#quietSince = null;
      this.#speechEndAt = null; // the user is talking again: the earlier end no longer starts a reply
      return;
    }
    if (this.#speechStartedAt === null) return;
    this.#quietSince ??= now;
    if (now - this.#quietSince < QUIET_MS) return;
    if (this.#quietSince - this.#speechStartedAt >= MIN_SPEECH_MS) this.#speechEndAt = this.#quietSince;
    this.#speechStartedAt = null;
    this.#quietSince = null;
  }

  /** An agent transcript line arrived: its id names the turn whose audio follows. */
  onAgentLine(turnId: string): void {
    this.#turnId = turnId;
  }

  /** Agent audio was scheduled to start playing at `startsAt` (same clock as the mic levels). */
  onAgentAudio(startsAt: number): void {
    const endedAt = this.#speechEndAt;
    const turnId = this.#turnId;
    if (endedAt === null || turnId === null) return;
    this.#speechEndAt = null; // one sample per user utterance: the first audio of the reply
    const ms = Math.round(startsAt - endedAt);
    if (ms < 0 || ms > MAX_MS || startsAt - endedAt > MARK_TTL_MS) return;
    this.#send({ type: ChatClientMessageType.CLIENT_METRIC, name: "turnLatency", turnId, ms, at: new Date().toISOString() });
  }

  reset(): void {
    this.#speechStartedAt = null;
    this.#quietSince = null;
    this.#speechEndAt = null;
    this.#turnId = null;
  }
}

// The page's probe. useChat owns the /chat socket and registers how to send; without one (demo mode, a closed socket)
// samples are dropped.
let sink: ((metric: ClientMetric) => void) | null = null;

export function registerMetricSink(next: (metric: ClientMetric) => void): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export const latencyProbe = new LatencyProbe((metric) => sink?.(metric));
