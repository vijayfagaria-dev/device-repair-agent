// The LLM behaviour eval (P9-T03): the real system prompt, tools and state message, a fixture's conversation, and the
// real model router. It measures the pass rate on the main set and on a held-out set (cases nobody tuned the prompt on),
// and the token cost from the provider's own usage figures at list prices.
//
//   npm run eval -w server -- --dry                      judges each fixture's reference answer: no model, no network
//   EVAL_BUDGET_APPROVED=1 npm run eval -w server        the real model. Refuses to run without the approval flag.
//
// A real run spends free-tier quota (one request per fixture; about 2–3K prompt tokens each) and sends only synthetic
// text. Its thresholds (P9 gate): ≥ 90% on the main set, ≥ 85% on the held-out set (5 cases: all must pass).
import { Secret } from "../config.js";
import { createLlmRouter, llmHops } from "../agent/llm.js";
import { systemMessage } from "../agent/prompt.js";
import { parseToolCall, TOOLS } from "../agent/tools.js";
import { findPrice, listPriceUsd } from "../metrics/prices.js";
import type { LlmClient, LlmMessage, LlmUsage } from "../voice/types.js";
import { type Fixture, type FixtureSet, loadFixtures } from "./fixtures.js";
import { type ActualCall, judge } from "./match.js";

export const THRESHOLDS = { main: 0.9, heldout: 0.85 } as const;

/** What the model is shown for a fixture: the frozen system prompt, the conversation, the state message. */
export function buildMessages(fixture: Fixture): LlmMessage[] {
  return [
    systemMessage(),
    ...fixture.transcript.map((turn): LlmMessage => ({ role: turn.role, content: turn.text }) as LlmMessage),
    { role: "system", content: `STATE ${JSON.stringify(fixture.state)}` },
  ];
}

export interface CaseResult {
  id: string;
  set: FixtureSet;
  pass: boolean;
  failures: string[];
  calls: ActualCall[];
  speech: string;
  usage: LlmUsage | null;
  model: string | null;
}

export type Answer = { calls: ActualCall[]; speech: string; usage: LlmUsage | null; model: string | null };

/** The model's first response to a fixture, through the real router and the real tool-call validation. */
export async function askModel(llm: LlmClient, fixture: Fixture): Promise<Answer> {
  const stream = await llm.stream({ messages: buildMessages(fixture), tools: TOOLS });
  const calls: ActualCall[] = [];
  let speech = "";
  let usage: LlmUsage | null = null;
  for await (const chunk of stream) {
    if (chunk.type === "text") speech += chunk.delta;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "toolCall") {
      // Validated exactly as in a call: an invalid call is not a call the agent would have made.
      const parsed = parseToolCall(chunk.call.name, chunk.call.arguments);
      if (parsed.ok) calls.push({ name: parsed.call.name, args: parsed.call.args as Record<string, unknown> });
      else calls.push({ name: `(invalid ${chunk.call.name})`, args: {} });
    }
  }
  return { calls, speech, usage, model: stream.route.model };
}

export function grade(fixture: Fixture, set: FixtureSet, answer: Answer): CaseResult {
  const verdict = judge(fixture.expect, answer.calls, answer.speech);
  return { id: fixture.id, set, pass: verdict.pass, failures: verdict.failures, calls: answer.calls, speech: answer.speech, usage: answer.usage, model: answer.model };
}

/** The reference answer of a fixture, as an Answer (the dry run: proves the expectation can be met). */
export const referenceAnswer = (fixture: Fixture): Answer => ({ calls: fixture.reference.calls as ActualCall[], speech: fixture.reference.speech, usage: null, model: null });

export interface Report {
  results: CaseResult[];
  passRate: Record<FixtureSet, number>;
  cases: Record<FixtureSet, number>;
  tokens: { prompt: number; completion: number; cached: number };
  costUsd: number | null;
  meetsThresholds: boolean;
}

export function report(results: readonly CaseResult[]): Report {
  const rate = (set: FixtureSet) => {
    const rows = results.filter((r) => r.set === set);
    return rows.length === 0 ? 0 : rows.filter((r) => r.pass).length / rows.length;
  };
  const tokens = { prompt: 0, completion: 0, cached: 0 };
  let costUsd: number | null = 0;
  for (const r of results) {
    if (!r.usage || !r.model) {
      costUsd = null;
      continue;
    }
    tokens.prompt += r.usage.promptTokens;
    tokens.completion += r.usage.completionTokens;
    tokens.cached += r.usage.cachedTokens;
    const input = findPrice("groq", `${r.model}:input`) ?? findPrice("gemini", `${r.model}:input`);
    const output = findPrice("groq", `${r.model}:output`) ?? findPrice("gemini", `${r.model}:output`);
    if (costUsd !== null && input && output) costUsd += listPriceUsd(input, r.usage.promptTokens) + listPriceUsd(output, r.usage.completionTokens);
    else costUsd = null;
  }
  const passRate = { main: rate("main"), heldout: rate("heldout") };
  return {
    results: [...results],
    passRate,
    cases: { main: results.filter((r) => r.set === "main").length, heldout: results.filter((r) => r.set === "heldout").length },
    tokens,
    costUsd,
    meetsThresholds: passRate.main >= THRESHOLDS.main && passRate.heldout >= THRESHOLDS.heldout,
  };
}

export async function runEval(ask: (fixture: Fixture) => Promise<Answer>, sets: readonly FixtureSet[] = ["main", "heldout"]): Promise<Report> {
  const results: CaseResult[] = [];
  for (const set of sets) for (const fixture of loadFixtures(set)) results.push(grade(fixture, set, await ask(fixture)));
  return report(results);
}

function print(r: Report, label: string): void {
  for (const c of r.results) console.log(`${c.pass ? "PASS" : "FAIL"} [${c.set}] ${c.id}${c.pass ? "" : `\n       ${c.failures.join("\n       ")}\n       model said: ${JSON.stringify(c.speech)} calls: ${JSON.stringify(c.calls)}`}`);
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  console.log(`\n${label}: main ${pct(r.passRate.main)} (${r.cases.main} cases, need ${pct(THRESHOLDS.main)}) · held-out ${pct(r.passRate.heldout)} (${r.cases.heldout} cases, need ${pct(THRESHOLDS.heldout)})`);
  console.log(`tokens: prompt ${r.tokens.prompt}, completion ${r.tokens.completion}, cached ${r.tokens.cached}; list-price cost ${r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(5)}`}`);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  if (dry) {
    const r = await runEval(async (fixture) => referenceAnswer(fixture));
    print(r, "DRY RUN (each fixture's own reference answer; this does not measure any model)");
    process.exit(r.passRate.main === 1 && r.passRate.heldout === 1 ? 0 : 1);
  }
  if (process.env.EVAL_BUDGET_APPROVED !== "1") {
    console.error("Refusing to call the real model: set EVAL_BUDGET_APPROVED=1 once the run budget is approved (25 requests of about 2–3K prompt tokens each, free tier), or use --dry.");
    process.exit(2);
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.error("GROQ_API_KEY is not set (run from server/ so .env is loaded: node --env-file=.env dist/eval/run.js).");
    process.exit(2);
  }
  const gemini = process.env.GEMINI_API_KEY ? new Secret(process.env.GEMINI_API_KEY) : null;
  const models = [`groq:${process.env.LLM_MODEL ?? "openai/gpt-oss-20b"}`, ...(process.env.LLM_FALLBACK_MODELS ?? "groq:openai/gpt-oss-120b").split(",").filter(Boolean)];
  const llm = createLlmRouter({ hops: llmHops({ groqApiKey: new Secret(key), geminiApiKey: gemini, models }) });
  const r = await runEval((fixture) => askModel(llm, fixture));
  print(r, "REAL MODEL");
  process.exit(r.meetsThresholds ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(String((err as Error)?.message ?? err));
    process.exit(1);
  });
}
