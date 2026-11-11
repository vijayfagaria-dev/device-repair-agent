// A scriptable STT provider (P5-T01): tests push events by hand or replay a recorded Deepgram fixture.
import { toSttEvent } from "../deepgram.js";
import type { SttEvent, SttProvider, SttStream } from "../types.js";

export class FakeStt implements SttProvider {
  /** Every stream opened, newest last. */
  readonly streams: FakeSttStream[] = [];
  /** Make the next open() fail (a provider that can't be reached). */
  failNextOpen = 0;
  /** A provider that takes this long to open (the handshake from far away). */
  openDelayMs = 0;

  async open(onEvent: (event: SttEvent) => void): Promise<SttStream> {
    if (this.failNextOpen > 0) {
      this.failNextOpen -= 1;
      throw new Error("fake STT unavailable");
    }
    if (this.openDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.openDelayMs));
    const stream = new FakeSttStream(onEvent);
    this.streams.push(stream);
    return stream;
  }

  get current(): FakeSttStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no STT stream open");
    return stream;
  }
}

export class FakeSttStream implements SttStream {
  bytes = 0;
  closed = false;
  /** A provider that takes a while to close (shutdown must still commit EndCall, P5 review #4). */
  closeDelayMs = 0;
  constructor(readonly onEvent: (event: SttEvent) => void) {}

  push(pcm: Buffer): void {
    if (!this.closed) this.bytes += pcm.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.closeDelayMs));
    this.onEvent({ type: "closed" });
  }

  emit(event: SttEvent): void {
    if (!this.closed) this.onEvent(event);
  }

  /** The user said `text`: speechStarted, an interim, then a final that ends the speech. */
  say(text: string): void {
    this.emit({ type: "speechStarted" });
    this.emit({ type: "transcript", text: text.split(" ").slice(0, 2).join(" "), isFinal: false, speechFinal: false });
    this.emit({ type: "transcript", text, isFinal: true, speechFinal: true });
  }

  /** Emits a recorded fixture's Deepgram messages in order (no timing). */
  replay(messages: readonly unknown[]): void {
    for (const message of messages) {
      const event = toSttEvent(message);
      if (event) this.emit(event);
    }
  }
}
