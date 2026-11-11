// The LLM router (P5-T06): REAL Groq and Gemini streams captured in P5-T01 (fixtures/providers/llm-streams.json)
// replayed through agent/llm.ts with a fake SDK client, and the fallback chain (D06) with scripted failures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLlmRouter, type LlmHop, shouldFallBack, toOpenAiMessages } from "../../src/agent/llm.js";
import { TOOLS } from "../../src/agent/tools.js";
import { type LlmChunk, LlmError, type LlmMessage } from "../../src/voice/types.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/providers/llm-streams.json", import.meta.url), "utf8"));

/** A fake SDK client: each create() replays a script (raw chunks, an error, or a stall). */
function client(...scripts: ({ raw: unknown[] } | { error: unknown } | { stall: true })[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          calls.push(params);
          const script = scripts.shift();
          if (!script) throw new Error("no script");
          if ("error" in script) throw script.error;
          return {
            async *[Symbol.asyncIterator]() {
              if ("stall" in script) {
                await new Promise((_resolve, reject) => opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }))));
                return;
              }
              for (const chunk of script.raw) yield chunk;
            },
          };
        },
      },
    },
  };
}

/** The usage a stream reported last (the total): what the router must emit, once. */
function lastUsage(raw: { usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } | null }[]) {
  const usage = raw.filter((r) => r.usage).at(-1)?.usage;
  return { promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 };
}

const hop = (c: ReturnType<typeof client>, provider: "groq" | "gemini" = "groq", model = "openai/gpt-oss-20b"): LlmHop => ({ provider, model, client: c as never, extra: provider === "groq" ? { reasoning_effort: "low" } : {} });
const collect = async (stream: AsyncIterable<LlmChunk>) => {
  const chunks: LlmChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
};
const messages: LlmMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];

describe("real streams replayed through the router", () => {
  it("Groq: a tool call assembled from deltas, and the usage reported once (Groq repeats it)", async () => {
    const c = client({ raw: fixture.groq.turn.raw });
    const stream = await createLlmRouter({ hops: [hop(c)] }).stream({ messages, tools: TOOLS });
    const chunks = await collect(stream);
    expect(chunks.map((ch) => ch.type)).toEqual(["toolCall", "usage", "done"]);
    const call = chunks[0]?.type === "toolCall" ? chunks[0].call : null;
    expect(call?.name).toBe("save_field");
    expect(JSON.parse(call?.arguments ?? "{}")).toMatchObject({ field: "deviceType", value: "smartphone" });
    expect(fixture.groq.turn.raw.filter((r: { usage?: unknown }) => r.usage).length).toBeGreaterThanOrEqual(1);
    expect(chunks[1]).toEqual({ type: "usage", usage: lastUsage(fixture.groq.turn.raw) });
    expect(stream.route).toEqual({ provider: "groq", model: "openai/gpt-oss-20b" });
    expect(stream.ttftMs).not.toBeNull();
    // What was sent: the D06 parameters.
    expect(c.calls[0]).toMatchObject({ model: "openai/gpt-oss-20b", tool_choice: "auto", stream: true, stream_options: { include_usage: true }, reasoning_effort: "low" });
    expect((c.calls[0]?.tools as unknown[] | undefined)?.length).toBe(TOOLS.length);
  });

  it("Gemini: text and three calls (index 0 reused, a new id starts a new call); thought_signature kept and echoed", async () => {
    const c = client({ raw: fixture.gemini.turn.raw });
    const chunks = await collect(await createLlmRouter({ hops: [hop(c, "gemini", "gemini-flash-lite-latest")] }).stream({ messages, tools: TOOLS }));
    const calls = chunks.flatMap((ch) => (ch.type === "toolCall" ? [ch.call] : []));
    expect(calls.map((call) => JSON.parse(call.arguments).field)).toEqual(["deviceType", "deviceModel", "problemDescription"]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(3);
    expect(calls[0]?.extra).toEqual({ google: { thought_signature: "<redacted signature>" } });
    // Gemini reports usage on several chunks, cumulatively: one usage chunk out, the latest.
    expect(fixture.gemini.turn.raw.filter((r: { usage?: unknown }) => r.usage).length).toBeGreaterThan(1);
    expect(chunks.filter((ch) => ch.type === "usage")).toEqual([{ type: "usage", usage: lastUsage(fixture.gemini.turn.raw) }]);
    // The follow-up request echoes it back (P0-T03: without it Gemini answers 400). The real follow-up succeeded.
    const echoed = toOpenAiMessages([{ role: "assistant", content: null, toolCalls: calls }]);
    expect((echoed[0] as { tool_calls: { extra_content?: unknown }[] }).tool_calls[0]?.extra_content).toEqual(calls[0]?.extra);
    expect(fixture.gemini.followUp.raw.length).toBeGreaterThan(0);
  });
});

describe("the fallback chain (D06)", () => {
  const status = (s: number) => Object.assign(new Error(`HTTP ${s}`), { status: s });

  it("a 429 from the primary is answered by the next route within the same turn", async () => {
    const failed: unknown[] = [];
    const primary = client({ error: status(429) });
    const second = client({ raw: fixture.groq.turn.raw });
    const router = createLlmRouter({ hops: [hop(primary), hop(second, "groq", "openai/gpt-oss-120b")], onHopFailed: (route, error) => failed.push([route.model, error.status]) });
    const stream = await router.stream({ messages, tools: TOOLS });
    expect(stream.route.model).toBe("openai/gpt-oss-120b");
    expect((await collect(stream)).some((ch) => ch.type === "toolCall")).toBe(true);
    expect(failed).toEqual([["openai/gpt-oss-20b", 429]]);
  });

  it("5xx, a network error, no first output within the TTFT timeout, and empty output all move on; a 400 doesn't", async () => {
    for (const first of [{ error: status(503) }, { error: new Error("ECONNRESET") }, { stall: true as const }, { raw: [] }]) {
      const router = createLlmRouter({ ttftTimeoutMs: 50, hops: [hop(client(first)), hop(client({ raw: fixture.groq.turn.raw }), "gemini", "gemini-flash-lite-latest")] });
      expect((await router.stream({ messages, tools: TOOLS })).route.provider).toBe("gemini");
    }
    const router = createLlmRouter({ hops: [hop(client({ error: status(400) })), hop(client({ raw: fixture.groq.turn.raw }))] });
    await expect(router.stream({ messages, tools: TOOLS })).rejects.toMatchObject({ status: 400 });
  });

  it("every route failing rejects with the last error; an abort stops the chain", async () => {
    const router = createLlmRouter({ hops: [hop(client({ error: status(429) })), hop(client({ error: status(500) }))] });
    await expect(router.stream({ messages, tools: TOOLS })).rejects.toMatchObject({ status: 500 });
    const controller = new AbortController();
    controller.abort();
    await expect(createLlmRouter({ hops: [hop(client({ raw: [] }))] }).stream({ messages, tools: TOOLS, signal: controller.signal })).rejects.toMatchObject({ status: "aborted" });
    expect(shouldFallBack(429) && shouldFallBack(502) && shouldFallBack("timeout") && shouldFallBack(null)).toBe(true);
    expect(shouldFallBack(400) || shouldFallBack(401)).toBe(false);
    expect(new LlmError("x", "empty").status).toBe("empty");
  });
});
