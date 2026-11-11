// A scriptable LLM (P5-T01): each call takes the next script. Scripts are text, tool calls, usage, a failure, or a
// route that fails first so the next one answers (the fallback chain), mirroring agent/llm.ts's contract.
import { type ChatToolCall, type LlmChunk, type LlmClient, LlmError, type LlmRequest, type LlmRoute, type LlmTurnStream } from "../types.js";

export interface LlmScript {
  text?: string;
  toolCalls?: { name: string; args: unknown; id?: string; extra?: Record<string, unknown> }[];
  /** Thrown instead of answering. */
  error?: LlmError;
  route?: LlmRoute;
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
  /** Deliver the text in pieces this long (to exercise streaming). */
  pieceChars?: number;
  /** Wait for this promise before yielding each chunk (lets tests interleave). */
  gate?: () => Promise<void>;
  /** The stream throws after this many chunks (a connection that dies mid-reply, as on the live call of 2026-11-11). */
  breakAfter?: number;
  /** The first route failed and this one answered: onFallback is called first, as the real router does. */
  fellBack?: boolean;
}

export const DEFAULT_ROUTE: LlmRoute = { provider: "groq", model: "openai/gpt-oss-20b" };

export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  readonly #scripts: LlmScript[] = [];
  /** Used when no script is queued. */
  fallback: LlmScript = { text: "Okay." };

  enqueue(...scripts: LlmScript[]): this {
    this.#scripts.push(...scripts);
    return this;
  }

  get queued(): number {
    return this.#scripts.length;
  }

  async stream(request: LlmRequest): Promise<LlmTurnStream> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const script = this.#scripts.shift() ?? this.fallback;
    if (script.error) throw script.error;
    if (request.signal?.aborted) throw new LlmError("aborted", "aborted");
    if (script.fellBack) request.onFallback?.(script.route ?? DEFAULT_ROUTE);
    const chunks: LlmChunk[] = [];
    const text = script.text ?? "";
    const size = script.pieceChars ?? (text.length || 1);
    for (let i = 0; i < text.length; i += size) chunks.push({ type: "text", delta: text.slice(i, i + size) });
    script.toolCalls?.forEach((call, i) => {
      const toolCall: ChatToolCall = { id: call.id ?? `call_${this.requests.length}_${i}`, name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) };
      if (call.extra) toolCall.extra = call.extra;
      chunks.push({ type: "toolCall", call: toolCall });
    });
    chunks.push({ type: "usage", usage: { promptTokens: script.usage?.promptTokens ?? 900, completionTokens: script.usage?.completionTokens ?? 20, cachedTokens: script.usage?.cachedTokens ?? 0 } });
    chunks.push({ type: "done", finishReason: script.toolCalls?.length ? "tool_calls" : "stop" });
    const signal = request.signal;
    return {
      route: script.route ?? DEFAULT_ROUTE,
      ttftMs: 120,
      async *[Symbol.asyncIterator]() {
        let sent = 0;
        for (const chunk of chunks) {
          if (script.breakAfter !== undefined && sent++ >= script.breakAfter) throw new LlmError("stream broke", null);
          if (script.gate) await script.gate();
          if (signal?.aborted) return;
          yield chunk;
        }
      },
    };
  }
}
