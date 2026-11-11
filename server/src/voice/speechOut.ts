// Speech output (P5-T11): one agent turn at a time. Streamed text → sentence chunks → TTS; the turn's audio frames go
// to the browser as `audio` messages; the agent `transcript` line (`ta_<callId>_<n>`, one id per turn) grows with the
// text sent and is final when the turn has been spoken or was interrupted. It tracks the audio duration sent per
// chunk, so barge-in can truncate the line at what the user actually heard (P5-T07), and the first-audio time.
import { type CallServerMessage, CallServerMessageType, Role } from "@device-repair/shared/protocol";
import { SentenceChunker } from "../agent/sentenceChunker.js";
import type { Clock } from "./clock.js";
import { pcmBytesPerSecond, type TtsEvent, type TtsStream } from "./types.js";

/** What the call socket sends (protocol.md §3.2). */
export type CallMessage = CallServerMessage;

export interface SpokenTurn {
  id: string;
  /** All text sent to TTS (the full line when the turn completed). */
  text: string;
  interrupted: boolean;
  /** What the user heard, when interrupted (the line is truncated to this plus " [interrupted]"). */
  heard: string;
  firstAudioAt: number | null;
  /** Characters sent to TTS (the ledger's Aura-2 meter). */
  characters: number;
}

interface Chunk {
  text: string;
  /** Audio received for this chunk so far. */
  audioMs: number;
  /** All of its audio has arrived (Flushed). */
  complete?: boolean;
}

/** Speaking rate assumed before any chunk has finished (Aura-2 at a normal pace, about 15 characters a second). */
export const DEFAULT_MS_PER_CHAR = 65;

export const INTERRUPTED_MARK = " [interrupted]";

/**
 * The words of `chunks` heard after `playedMs` of audio: whole chunks, then a proportional cut at a word boundary. A
 * chunk whose audio is still arriving is as long as its text at the rate of the finished chunks (its received audio
 * alone would make it look shorter, and fully heard).
 */
export function heardText(chunks: readonly Chunk[], playedMs: number): string {
  const done = chunks.filter((c) => c.complete !== false && c.audioMs > 0);
  const chars = done.reduce((n, c) => n + c.text.length, 0);
  const msPerChar = chars > 0 ? done.reduce((n, c) => n + c.audioMs, 0) / chars : DEFAULT_MS_PER_CHAR;
  let left = playedMs;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (left <= 0) break;
    const duration = chunk.complete === false ? Math.max(chunk.audioMs, chunk.text.length * msPerChar) : chunk.audioMs;
    if (duration <= left) {
      parts.push(chunk.text);
      left -= duration;
      continue;
    }
    const cut = Math.floor((chunk.text.length * left) / duration);
    let partial = chunk.text.slice(0, cut);
    // A cut inside a word keeps only the words before it.
    if (cut < chunk.text.length && !/\s/.test(chunk.text[cut] ?? "")) partial = partial.replace(/\S*$/, "");
    partial = partial.trim();
    if (partial) parts.push(partial);
    break;
  }
  return parts.join(" ").trim();
}

export class SpeechTurn {
  readonly #chunker = new SentenceChunker();
  readonly #chunks: Chunk[] = [];
  #text = "";
  #audioBytes = 0;
  #firstAudioAt: number | null = null;
  /**
   * When the browser will have played everything received so far: each frame plays after the previous one, or when it
   * arrives if the player had run dry (a gap: ack → follow-up, a slow route). P5 review #9.
   */
  #playCursor: number | null = null;
  #unflushed = 0;
  #ended = false;
  #finished = false;
  #cancelled: SpokenTurn | null = null;
  #resolveDone!: (turn: SpokenTurn) => void;
  /** Resolves when everything sent has been spoken (or the turn was cancelled). */
  readonly done: Promise<SpokenTurn>;

  constructor(
    readonly id: string,
    readonly tts: TtsStream,
    readonly clock: Clock,
    readonly send: (message: CallMessage) => void,
  ) {
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  get firstAudioAt(): number | null {
    return this.#firstAudioAt;
  }

  /** True once any audio of this turn reached the socket. */
  get audible(): boolean {
    return this.#firstAudioAt !== null;
  }

  /** Everything was sent (or the turn was cancelled). The user may still be hearing it: see `speaking`. */
  get finished(): boolean {
    return this.#finished;
  }

  /**
   * When the browser will have played everything sent, assuming it plays continuously from the first frame. TTS sends
   * faster than real time (Aura-2 delivers seconds of audio in a fraction of that), so this is later than `done`.
   */
  playbackEndsAt(): number {
    return this.#playCursor ?? this.clock.now();
  }

  /** The text sent to TTS so far. */
  get text(): string {
    return this.#text;
  }

  /** Speaks what the chunker holds now, as its own chunk (a templated acknowledgement mustn't wait for more text). */
  breakChunk(): void {
    if (this.#ended || this.#cancelled) return;
    for (const chunk of this.#chunker.flush()) this.#sendChunk(chunk);
  }

  /** The user is (by the estimate) still hearing this turn: not cancelled, and audio is still coming or playing. */
  get speaking(): boolean {
    if (this.#cancelled) return false;
    return !this.#finished || this.clock.now() < this.playbackEndsAt();
  }

  /** Resolves when the turn has been played out (or interrupted, with the interrupted result). */
  async playedOut(): Promise<SpokenTurn> {
    const sent = await this.done;
    if (this.#cancelled) return this.#cancelled;
    const wait = this.playbackEndsAt() - this.clock.now();
    if (wait <= 0) return sent;
    return new Promise<SpokenTurn>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.#onInterrupt = null;
        resolve(this.#cancelled ?? sent);
      }, wait);
      this.#onInterrupt = (interrupted) => {
        this.clock.clearTimeout(timer);
        resolve(interrupted);
      };
    });
  }

  #onInterrupt: ((turn: SpokenTurn) => void) | null = null;

  /** Streamed text from the model (or a templated line). */
  say(delta: string): void {
    if (this.#ended || this.#cancelled) return;
    for (const chunk of this.#chunker.push(delta)) this.#sendChunk(chunk);
  }

  /** No more text: speak what is left. */
  end(): void {
    if (this.#ended || this.#cancelled) return;
    this.#ended = true;
    for (const chunk of this.#chunker.flush()) this.#sendChunk(chunk);
    this.#maybeFinish();
  }

  #sendChunk(text: string): void {
    this.#chunks.push({ text, audioMs: 0, complete: false });
    this.#text = this.#text ? `${this.#text} ${text}` : text;
    this.#unflushed += 1;
    this.tts.speak(this.id, text);
    this.tts.flush(this.id);
    this.send({ type: CallServerMessageType.TRANSCRIPT, id: this.id, role: Role.AGENT, text: this.#text, final: false });
  }

  /** A TTS event for this turn (the engine routes by turnId). */
  onTts(event: TtsEvent): void {
    if (this.#cancelled || this.#finished) return;
    if (event.type === "audio") {
      const now = this.clock.now();
      this.#firstAudioAt ??= now;
      this.#playCursor = Math.max(this.#playCursor ?? now, now) + (event.pcm.length * 1000) / pcmBytesPerSecond(event.sampleRate);
      this.#audioBytes += event.pcm.length;
      const current = this.#chunks[this.#chunks.length - this.#unflushed];
      if (current) current.audioMs += (event.pcm.length * 1000) / pcmBytesPerSecond(event.sampleRate);
      this.send({ type: CallServerMessageType.AUDIO, data: event.pcm.toString("base64"), sampleRate: event.sampleRate });
    } else if (event.type === "flushed") {
      const finished = this.#chunks[this.#chunks.length - this.#unflushed];
      if (finished) finished.complete = true;
      this.#unflushed = Math.max(0, this.#unflushed - 1);
      this.#maybeFinish();
    }
  }

  #maybeFinish(): void {
    if (!this.#ended || this.#unflushed > 0 || this.#finished) return;
    this.#finished = true;
    if (this.#text) this.send({ type: CallServerMessageType.TRANSCRIPT, id: this.id, role: Role.AGENT, text: this.#text, final: true });
    this.#resolveDone(this.#result(false, this.#text));
  }

  /** Audio sent but (by the estimate) not yet played: the client's buffer. */
  bufferedMs(): number {
    return Math.max(0, this.playbackEndsAt() - this.clock.now());
  }

  sentMs(): number {
    return this.#chunks.reduce((sum, c) => sum + c.audioMs, 0);
  }

  /**
   * Barge-in (P5-T07): stop at once. The caller has already sent stopPlayback; here no more audio is forwarded, TTS
   * drops the turn, and the line is truncated to what was heard (sent audio minus the client's buffer).
   */
  cancel(): SpokenTurn {
    if (this.#cancelled) return this.#cancelled;
    // Sent completely and played out: nothing to interrupt.
    if (this.#finished && !this.speaking) return this.#result(false, this.#text);
    // Played = everything sent minus what is still queued in the browser.
    const playedMs = Math.max(0, this.sentMs() - this.bufferedMs());
    const heard = heardText(this.#chunks, playedMs);
    this.tts.cancel(this.id);
    this.#finished = true;
    this.#cancelled = this.#result(true, heard);
    // The line (maybe already sent as final with the full text) is corrected in place: same id. Nothing sent yet:
    // there is no line to correct.
    if (this.#text) this.send({ type: CallServerMessageType.TRANSCRIPT, id: this.id, role: Role.AGENT, text: `${heard}${INTERRUPTED_MARK}`.trim(), final: true });
    this.#resolveDone(this.#cancelled);
    this.#onInterrupt?.(this.#cancelled);
    return this.#cancelled;
  }

  #result(interrupted: boolean, heard: string): SpokenTurn {
    return { id: this.id, text: this.#text, interrupted, heard, firstAudioAt: this.#firstAudioAt, characters: this.#chunks.reduce((n, c) => n + c.text.length, 0) };
  }
}
