// The call agent's LLM (P5-T06, D06): one `openai` SDK client per provider (Groq, and Gemini's OpenAI-compatible
// endpoint) behind the LlmClient interface. A turn goes to the first route; on 429, 5xx, a network error or no first
// output within the TTFT timeout (5 s) it moves to the next route, before anything was emitted, so prompts and tools
// are identical on every hop. Tool calls are accumulated by `index`, a new `id` starting a new call (Gemini reuses
// index 0); Gemini's `extra_content` (thought_signature) is kept so the follow-up can echo it (P0-T03).
import OpenAI from "openai";
import type { Secret } from "../config.js";
import { type ChatToolCall, type LlmChunk, type LlmClient, LlmError, type LlmMessage, type LlmRequest, type LlmRoute, type LlmTurnStream, type LlmUsage } from "../voice/types.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export interface LlmHop extends LlmRoute {
  client: Pick<OpenAI, "chat">;
  /** Provider-specific request params (Groq gpt-oss: reasoning_effort "low"; Gemini rejects it). */
  extra?: Record<string, unknown>;
}

export interface LlmRouterOptions {
  hops: readonly LlmHop[];
  ttftTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  now?: () => number;
  /** Told about every hop that failed (for the log and the quota guard). */
  onHopFailed?: (route: LlmRoute, error: LlmError) => void;
}

/** One route per configured model: `groq:<model>` or `gemini:<model>`; Gemini only with a key. */
export function llmHops(config: { groqApiKey: Secret; geminiApiKey: Secret | null; models: readonly string[] }): LlmHop[] {
  const groq = new OpenAI({ apiKey: config.groqApiKey.reveal(), baseURL: GROQ_BASE_URL, maxRetries: 0, timeout: 20_000 });
  const gemini = config.geminiApiKey ? new OpenAI({ apiKey: config.geminiApiKey.reveal(), baseURL: GEMINI_BASE_URL, maxRetries: 0, timeout: 20_000 }) : null;
  return config.models.flatMap((entry): LlmHop[] => {
    const [provider, ...rest] = entry.split(":");
    const model = rest.join(":");
    if (provider === "groq") return [{ provider, model, client: groq, extra: model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {} }];
    if (provider === "gemini" && gemini) return [{ provider, model, client: gemini, extra: {} }];
    return [];
  });
}

/** LlmMessage → the OpenAI chat format (tool calls with Gemini's extra_content echoed). */
export function toOpenAiMessages(messages: readonly LlmMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    switch (m.role) {
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments }, ...(c.extra ? { extra_content: c.extra } : {}) })) }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

/** Whether the next route should take over (D06: 429 or 5xx; also timeouts and network errors). */
export const shouldFallBack = (status: LlmError["status"]): boolean => status === null || status === "timeout" || status === 429 || (typeof status === "number" && status >= 500);

function toLlmError(err: unknown, timedOut: boolean): LlmError {
  if (timedOut) return new LlmError("no first output within the TTFT timeout", "timeout");
  if (err instanceof LlmError) return err;
  const e = err as { status?: unknown; name?: string; message?: string };
  if (e?.name === "AbortError" || e?.name === "APIUserAbortError") return new LlmError("aborted", "aborted");
  return new LlmError(String(e?.message ?? err).slice(0, 200), typeof e?.status === "number" ? e.status : null);
}

interface Pending {
  id: string | undefined;
  name: string;
  args: string;
  extra?: Record<string, unknown>;
}

export function createLlmRouter(options: LlmRouterOptions): LlmClient {
  const ttftTimeoutMs = options.ttftTimeoutMs ?? 5_000;
  const now = options.now ?? (() => performance.now());

  async function openHop(hop: LlmHop, request: LlmRequest): Promise<LlmTurnStream> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ttftTimeoutMs);
    const started = now();
    let ttftMs: number | null = null;
    const done = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    };

    let sdkStream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      sdkStream = (await hop.client.chat.completions.create(
        {
          model: hop.model,
          messages: toOpenAiMessages(request.messages),
          tools: request.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: "auto",
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: options.maxTokens ?? 400,
          temperature: options.temperature ?? 0.3,
          ...hop.extra,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: controller.signal },
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (err) {
      done();
      throw toLlmError(err, timedOut);
    }

    const iterator = sdkStream[Symbol.asyncIterator]();
    const calls = new Map<string, Pending>();
    let finishReason: string | null = null;
    const buffered: LlmChunk[] = [];
    // Providers report usage more than once per stream (Groq twice, identical; Gemini on every chunk, cumulative:
    // P5-T01 capture). The latest is the total; it is emitted once, at the end.
    let usage: LlmUsage | null = null;

    /** Reads SDK chunks until it has LlmChunks to give (or the stream ended). */
    const pull = async (): Promise<boolean> => {
      for (;;) {
        let next: IteratorResult<OpenAI.Chat.Completions.ChatCompletionChunk>;
        try {
          next = await iterator.next();
        } catch (err) {
          throw toLlmError(err, timedOut);
        }
        if (next.done) return false;
        const chunk = next.value;
        if (chunk.usage) {
          const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0;
          usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens, cachedTokens: cached };
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (delta && ttftMs === null && (delta.content || delta.tool_calls?.length)) {
          ttftMs = Math.round(now() - started);
          clearTimeout(timer);
        }
        if (delta?.content) buffered.push({ type: "text", delta: delta.content });
        for (const tc of delta?.tool_calls ?? []) {
          let key = String(tc.index ?? 0);
          const existing = calls.get(key);
          if (tc.id && existing?.id && existing.id !== tc.id) key = `${key}:${tc.id}`;
          const current = calls.get(key) ?? { id: tc.id, name: "", args: "" };
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.name += tc.function.name;
          if (tc.function?.arguments) current.args += tc.function.arguments;
          const extra = (tc as { extra_content?: Record<string, unknown> }).extra_content;
          if (extra) current.extra = extra;
          calls.set(key, current);
        }
        if (buffered.length > 0) return true;
      }
    };

    // Wait for the first output before committing to this route; a failure until then lets the next one try.
    let more: boolean;
    try {
      more = await pull();
      while (more && !buffered.some((c) => c.type === "text")) more = await pull();
    } catch (err) {
      done();
      throw err;
    }
    if (ttftMs === null && calls.size === 0 && !buffered.some((c) => c.type === "text")) {
      done();
      throw new LlmError("the model returned no output", "empty");
    }

    const finalCalls = (): ChatToolCall[] =>
      [...calls.values()].map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, arguments: c.args || "{}", ...(c.extra ? { extra: c.extra } : {}) }));

    const route: LlmRoute = { provider: hop.provider, model: hop.model };
    return {
      route,
      get ttftMs() {
        return ttftMs;
      },
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (buffered.length > 0) yield buffered.shift() as LlmChunk;
            if (!more) break;
            more = await pull();
          }
          for (const call of finalCalls()) yield { type: "toolCall", call };
          if (usage) yield { type: "usage", usage };
          yield { type: "done", finishReason };
        } finally {
          done();
          controller.abort();
        }
      },
    };
  }

  return {
    async stream(request) {
      let last: LlmError | null = null;
      for (const [i, hop] of options.hops.entries()) {
        if (request.signal?.aborted) throw new LlmError("aborted", "aborted");
        try {
          return await openHop(hop, request);
        } catch (err) {
          const error = toLlmError(err, false);
          if (error.status === "aborted") throw error;
          options.onHopFailed?.({ provider: hop.provider, model: hop.model }, error);
          last = error;
          if (!shouldFallBack(error.status) && error.status !== "empty") throw error;
          const next = options.hops[i + 1];
          if (next) request.onFallback?.({ provider: next.provider, model: next.model });
        }
      }
      throw last ?? new LlmError("no LLM route configured", null);
    },
  };
}
