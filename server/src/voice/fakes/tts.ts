// A scriptable TTS provider (P5-T01): each flushed chunk becomes audio frames at 24 kHz (one 40 ms frame per
// `charsPerFrame` characters), emitted at once or on the injected clock, then `flushed`. cancel() drops the turn's
// remaining frames, as the real adapter does.
import type { Clock } from "../clock.js";
import { type TtsEvent, type TtsProvider, type TtsStream, pcmBytesPerSecond } from "../types.js";

export const FAKE_TTS_RATE = 24_000;
export const FAKE_FRAME_MS = 40;
const FRAME_BYTES = (pcmBytesPerSecond(FAKE_TTS_RATE) * FAKE_FRAME_MS) / 1000;

export interface FakeTtsOptions {
  /** With a clock, frames come one per FAKE_FRAME_MS; without, synchronously on flush. */
  clock?: Clock;
  charsPerFrame?: number;
  /** Clock time between frames (default FAKE_FRAME_MS: real time). Less is faster than real time, like Aura-2. */
  intervalMs?: number;
}

export class FakeTts implements TtsProvider {
  readonly streams: FakeTtsStream[] = [];
  failNextOpen = 0;
  constructor(readonly options: FakeTtsOptions = {}) {}

  async open(onEvent: (event: TtsEvent) => void): Promise<TtsStream> {
    if (this.failNextOpen > 0) {
      this.failNextOpen -= 1;
      throw new Error("fake TTS unavailable");
    }
    const stream = new FakeTtsStream(onEvent, this.options);
    this.streams.push(stream);
    return stream;
  }

  get current(): FakeTtsStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no TTS stream open");
    return stream;
  }
}

export class FakeTtsStream implements TtsStream {
  /** Every chunk flushed, in order: what the "voice" was asked to say. */
  readonly chunks: { turnId: string; text: string }[] = [];
  readonly cancelledTurns: string[] = [];
  closed = false;
  /** Make the next flush fail with an error event (a provider error mid-call). */
  failNextFlush = false;
  readonly #pending = new Map<string, string>();
  readonly #cancelled = new Set<string>();

  constructor(
    readonly onEvent: (event: TtsEvent) => void,
    readonly options: FakeTtsOptions,
  ) {}

  speak(turnId: string, text: string): void {
    if (this.#cancelled.has(turnId)) return;
    this.#pending.set(turnId, `${this.#pending.get(turnId) ?? ""}${text}`);
  }

  flush(turnId: string): void {
    const text = this.#pending.get(turnId);
    this.#pending.delete(turnId);
    if (!text || this.#cancelled.has(turnId)) return;
    this.chunks.push({ turnId, text });
    if (this.failNextFlush) {
      this.failNextFlush = false;
      this.onEvent({ type: "error", error: new Error("fake TTS failed") });
      return;
    }
    const frames = Math.max(1, Math.ceil(text.length / (this.options.charsPerFrame ?? 4)));
    const clock = this.options.clock;
    if (!clock) {
      for (let i = 0; i < frames; i++) this.onEvent({ type: "audio", turnId, pcm: Buffer.alloc(FRAME_BYTES), sampleRate: FAKE_TTS_RATE });
      this.onEvent({ type: "flushed", turnId });
      return;
    }
    // One chunk after another, like Aura-2: this chunk starts when the ones before it have played.
    const play = (done: () => void) => {
      let sent = 0;
      const next = () => {
        if (this.#cancelled.has(turnId) || this.closed) return done();
        if (sent < frames) {
          sent += 1;
          this.onEvent({ type: "audio", turnId, pcm: Buffer.alloc(FRAME_BYTES), sampleRate: FAKE_TTS_RATE });
          clock.setTimeout(next, this.options.intervalMs ?? FAKE_FRAME_MS);
        } else {
          this.onEvent({ type: "flushed", turnId });
          done();
        }
      };
      clock.setTimeout(next, 0);
    };
    this.#queue = this.#queue.then(() => new Promise<void>((resolve) => play(resolve)));
  }

  #queue: Promise<void> = Promise.resolve();

  cancel(turnId: string): void {
    this.#cancelled.add(turnId);
    this.cancelledTurns.push(turnId);
    this.#pending.delete(turnId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onEvent({ type: "closed" });
  }

  /** The text spoken for a turn, chunks joined. */
  spoken(turnId?: string): string {
    return this.chunks
      .filter((chunk) => turnId === undefined || chunk.turnId === turnId)
      .map((chunk) => chunk.text)
      .join(" ");
  }
}
