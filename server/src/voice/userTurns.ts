// The user side of the call (P5-T03): STT events → transcript lines (one id per utterance, `tu_<callId>_<n>`, reused
// by every interim and the final, protocol.md §1.1) and the end of the user's turn. Deepgram's `speech_final` ends the
// turn (P0-T03: it always came before UtteranceEnd), after a short merge window so a pause mid-sentence doesn't split
// it; `UtteranceEnd` is the backstop.
import type { Clock } from "./clock.js";
import type { SttEvent } from "./types.js";

export interface UserLine {
  id: string;
  text: string;
  final: boolean;
}

export interface Utterance {
  id: string;
  text: string;
  /** When the first words were heard and when the turn ended (ms, the clock's). */
  startedAt: number;
  endedAt: number;
  /**
   * When STT said the utterance was over (the last `speech_final` or `UtteranceEnd`), before the merge window:
   * the start of the server-side latency (D20). `endedAt - endEventAt` is the turn's own finalization wait.
   */
  endEventAt: number;
}

export interface UserTurnOptions {
  callId: string;
  clock: Clock;
  /** How long after `speech_final` more words still join the same turn. */
  mergeMs?: number;
  onLine(line: UserLine): void;
  onTurnEnd(utterance: Utterance): void;
  onSpeechStarted?(): void;
  /** Voice activity that never became words (echo, a cough, noise): the speaker is silent again. */
  onSpeechAbandoned?(): void;
  /** How long voice activity may go without words before it counts as nothing (default 1.5 s). */
  noWordsMs?: number;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export class UserTurns {
  readonly #options: UserTurnOptions;
  readonly #mergeMs: number;
  #count = 0;
  #current: { id: string; finals: string[]; interim: string; startedAt: number } | null = null;
  #endTimer: unknown = null;
  #endEventAt: number | null = null;
  #speechStartedAt: number | null = null;
  #noWordsTimer: unknown = null;

  constructor(options: UserTurnOptions) {
    this.#options = options;
    this.#mergeMs = options.mergeMs ?? 300;
  }

  /** Words heard so far in the utterance in progress (barge-in confirmation, P5-T07). */
  get words(): number {
    const c = this.#current;
    return c ? words([...c.finals, c.interim].join(" ")) : 0;
  }

  /** When voice activity started (speechStarted), until the utterance ends. */
  get speechStartedAt(): number | null {
    return this.#speechStartedAt;
  }

  get speaking(): boolean {
    return this.#current !== null || this.#speechStartedAt !== null;
  }

  handle(event: SttEvent): void {
    switch (event.type) {
      case "speechStarted":
        this.#speechStartedAt ??= this.#options.clock.now();
        // Deepgram sends UtteranceEnd only after words, so activity that never becomes words must expire on its own
        // (P5 review #7: otherwise "speaking" stays true and silence handling stops).
        if (!this.#current) {
          if (this.#noWordsTimer !== null) this.#options.clock.clearTimeout(this.#noWordsTimer);
          this.#noWordsTimer = this.#options.clock.setTimeout(() => {
            this.#noWordsTimer = null;
            if (this.#current) return;
            this.#speechStartedAt = null;
            this.#options.onSpeechAbandoned?.();
          }, this.#options.noWordsMs ?? 1_500);
        }
        this.#options.onSpeechStarted?.();
        return;
      case "transcript":
        this.#transcript(event.text.trim(), event.isFinal, event.speechFinal);
        return;
      case "utteranceEnd":
        if (this.#current) {
          this.#endEventAt = this.#options.clock.now();
          this.#end();
        } else if (this.#speechStartedAt !== null) {
          this.#speechStartedAt = null; // noise that never became words
          this.#options.onSpeechAbandoned?.();
        }
        return;
      default:
        return;
    }
  }

  #transcript(text: string, isFinal: boolean, speechFinal: boolean): void {
    if (text) {
      this.#cancelEnd();
      if (this.#noWordsTimer !== null) this.#options.clock.clearTimeout(this.#noWordsTimer);
      this.#noWordsTimer = null;
      if (!this.#current) {
        this.#current = { id: `tu_${this.#options.callId}_${++this.#count}`, finals: [], interim: "", startedAt: this.#speechStartedAt ?? this.#options.clock.now() };
      }
      if (isFinal) {
        this.#current.finals.push(text);
        this.#current.interim = "";
      } else {
        this.#current.interim = text;
      }
      const c = this.#current;
      this.#options.onLine({ id: c.id, text: [...c.finals, c.interim].filter(Boolean).join(" "), final: false });
    }
    if (speechFinal && this.#current) this.#endEventAt = this.#options.clock.now();
    if (speechFinal && this.#current && this.#endTimer === null) {
      this.#endTimer = this.#options.clock.setTimeout(() => {
        this.#endTimer = null;
        this.#end();
      }, this.#mergeMs);
    }
  }

  #cancelEnd(): void {
    if (this.#endTimer !== null) this.#options.clock.clearTimeout(this.#endTimer);
    this.#endTimer = null;
  }

  #end(): void {
    this.#cancelEnd();
    const c = this.#current;
    const endEventAt = this.#endEventAt ?? this.#options.clock.now();
    this.#current = null;
    this.#endEventAt = null;
    this.#speechStartedAt = null;
    if (!c) return;
    const text = (c.finals.length > 0 ? c.finals.join(" ") : c.interim).trim();
    this.#options.onLine({ id: c.id, text, final: true });
    if (text) this.#options.onTurnEnd({ id: c.id, text, startedAt: c.startedAt, endedAt: this.#options.clock.now(), endEventAt });
  }

  /** Ends any utterance in progress now (the call is ending). */
  flush(): void {
    if (this.#current) this.#end();
  }
}
