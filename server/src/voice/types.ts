// Provider interfaces for the call (P5-T01). The call engine is written against these only, so providers can be
// swapped and tests can run on scripted fakes (voice/fakes/*) without network or cost. Provider specifics (message
// names, URLs, auth) stay in the adapters: voice/deepgram.ts, voice/deepgramTts.ts, agent/llm.ts.

// ---------------------------------------------------------------------------------------------------------------------
// Speech to text

export type SttEvent =
  /** Voice activity began (Deepgram `SpeechStarted`): the earliest barge-in signal. */
  | { type: "speechStarted" }
  /**
   * A transcript for the current segment. `isFinal`: this segment's text won't change again. `speechFinal`: the
   * speaker paused long enough (endpointing) that this is the end of what they were saying.
   */
  | { type: "transcript"; text: string; isFinal: boolean; speechFinal: boolean }
  /** No words for a while after the last final (Deepgram `UtteranceEnd`): a backstop end of turn. */
  | { type: "utteranceEnd" }
  /** The stream failed; the adapter has stopped. */
  | { type: "error"; error: Error }
  /** The stream ended (after close(), or the provider closed it). */
  | { type: "closed" };

export interface SttStream {
  /** One 20 ms frame of PCM16 mono at 16 kHz (protocol.md §3.1). */
  push(pcm: Buffer): void;
  /** Flushes what is buffered and closes; resolves once closed. */
  close(): Promise<void>;
}

export interface SttProvider {
  /** Opens a stream; `onEvent` receives every event in order. Rejects if the stream can't be opened. */
  open(onEvent: (event: SttEvent) => void): Promise<SttStream>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Language model

export interface ChatToolCall {
  id: string;
  name: string;
  /** The raw JSON arguments as streamed (validated by the turn engine, never trusted). */
  arguments: string;
  /** Provider data that must be echoed back with the call in the follow-up (Gemini's thought_signature). */
  extra?: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: readonly LlmMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
  /** A route failed and `next` is about to be tried (the turn engine says "One moment." before the last resort). */
  onFallback?: (next: LlmRoute) => void;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export type LlmChunk =
  | { type: "text"; delta: string }
  /** A complete tool call (arguments fully streamed). */
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "usage"; usage: LlmUsage }
  | { type: "done"; finishReason: string | null };

/** Which provider and model actually answered (the fallback chain may have moved on). */
export interface LlmRoute {
  provider: "groq" | "gemini";
  model: string;
}

export interface LlmTurnStream extends AsyncIterable<LlmChunk> {
  readonly route: LlmRoute;
  /** Milliseconds from the request to the first text or tool call (TTFT), once known. */
  readonly ttftMs: number | null;
}

export interface LlmClient {
  /**
   * Starts one model call. Resolves once the first output has arrived (so the fallback chain can move on before
   * anything was emitted); rejects with an `LlmError` when every route failed.
   */
  stream(request: LlmRequest): Promise<LlmTurnStream>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    /** HTTP status, or "timeout" / "aborted" / "empty". */
    readonly status: number | "timeout" | "aborted" | "empty" | null,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Text to speech

export type TtsEvent =
  /** PCM16 mono audio for `turnId` (frames of a cancelled turn are never emitted). */
  | { type: "audio"; turnId: string; pcm: Buffer; sampleRate: number }
  /**
   * One chunk of `turnId` (its speak … flush) has been spoken: one event per flush, in order. (Per chunk, not per
   * turn: the speech pipeline counts them to know when a turn is done; the real-provider call caught a mismatch.)
   */
  | { type: "flushed"; turnId: string }
  | { type: "error"; error: Error }
  | { type: "closed" };

export interface TtsStream {
  /** Queues text for a turn. Text of one turn is spoken in order; `flush` marks the end of a chunk. */
  speak(turnId: string, text: string): void;
  flush(turnId: string): void;
  /** Stops a turn at once: no more of its audio is emitted (late provider frames are dropped). */
  cancel(turnId: string): void;
  close(): Promise<void>;
}

export interface TtsProvider {
  open(onEvent: (event: TtsEvent) => void): Promise<TtsStream>;
}

/** Bytes per second of PCM16 mono at a rate (2 bytes per sample). */
export const pcmBytesPerSecond = (sampleRate: number): number => sampleRate * 2;
