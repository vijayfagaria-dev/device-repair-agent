// The LLM eval harness (P9-T03), tested without any model: the judge, the fixtures, the report arithmetic and the budget
// guard. Whether the real model passes is measured by `npm run eval` after the budget is approved, not by these tests.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { describe, expect, it } from "vitest";
import { buildState } from "../../src/agent/stateMessage.js";
import { Fixture, loadFixtures } from "../../src/eval/fixtures.js";
import { Expectation, judge } from "../../src/eval/match.js";
import { askModel, buildMessages, grade, referenceAnswer, report, runEval, THRESHOLDS } from "../../src/eval/run.js";
import { REQUIRED_RECORD_FIELDS } from "../../src/domain/fields.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { ENTRY } from "../helpers/process.js";

const main = loadFixtures("main");
const heldout = loadFixtures("heldout");
const all = [...main, ...heldout];
const RUN = fileURLToPath(new URL("../../dist/eval/run.js", import.meta.url));
void ENTRY;

const expectation = (e: object) => Expectation.parse(e);

describe("the judge", () => {
  it("matches tool calls partially: name and the arguments given; strings case-insensitively; regex on request; extra calls don't matter", () => {
    const e = expectation({ calls: [{ name: "save_field", args: { field: "deviceType", value: { matches: "phone|smartphone" } } }] });
    expect(judge(e, [{ name: "save_field", args: { field: "DeviceType ", value: "Smartphone", spoken_evidence: "x" } }, { name: "end_call", args: {} }], "").pass).toBe(true);
    expect(judge(e, [{ name: "save_field", args: { field: "deviceModel", value: "phone" } }], "").failures).toEqual(["missing call save_field(field=\"deviceType\", value=/phone|smartphone/)"]);
    expect(judge(e, [], "").pass).toBe(false);
    expect(judge(expectation({ calls: [{ name: "opt_out", args: { confirmed: true } }] }), [{ name: "opt_out", args: { confirmed: false } }], "").pass).toBe(false);
  });

  it("a forbidden call fails the case, by name or by name and arguments", () => {
    const byName = expectation({ forbidden: [{ name: "opt_out" }] });
    expect(judge(byName, [{ name: "opt_out", args: { confirmed: false } }], "").pass).toBe(false);
    expect(judge(byName, [{ name: "save_field", args: {} }], "").pass).toBe(true);
    const byArgs = expectation({ forbidden: [{ name: "request_chat_input", args: { field: "serialNumber" } }] });
    expect(judge(byArgs, [{ name: "request_chat_input", args: { field: "email" } }], "").pass).toBe(true);
    expect(judge(byArgs, [{ name: "request_chat_input", args: { field: "serialNumber" } }], "").pass).toBe(false);
  });

  it("speech must match every pattern and none of the notMatches", () => {
    const e = expectation({ speech: { matches: ["stop|unplug"], notMatches: ["352099"] } });
    expect(judge(e, [], "Please STOP using it").pass).toBe(true);
    expect(judge(e, [], "Please keep using it").failures).toEqual(["speech should match /stop|unplug/"]);
    expect(judge(e, [], "stop. Your number 352099001761481").failures).toEqual(["speech must not match /352099/"]);
  });

  it("rejects an expectation with an unknown key (a typo can't silently pass)", () => {
    expect(() => expectation({ call: [] })).toThrow();
    expect(() => expectation({ calls: [{ name: "x", args: { a: [1] } }] })).toThrow();
  });
});

describe("the fixtures", () => {
  it("are about 25: 20 in the main set and 5 held out, with unique ids and every field valid", () => {
    expect(main).toHaveLength(20);
    expect(heldout).toHaveLength(5);
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    for (const f of all) expect(Fixture.safeParse(f).success, f.id).toBe(true);
  });

  it("each can be passed: its own reference answer satisfies it (a dry run, not a model measurement)", () => {
    for (const f of all) expect(grade(f, "main", referenceAnswer(f)), f.id).toMatchObject({ pass: true, failures: [] });
  });

  it("each can fail: a model that says nothing and does nothing fails every case that expects a call or speech", () => {
    const empty = { calls: [], speech: "", usage: null, model: null };
    const mustAct = all.filter((f) => f.expect.calls.length > 0 || f.expect.speech.matches.length > 0);
    for (const f of mustAct) expect(grade(f, "main", empty).pass, f.id).toBe(false);
    // The forbidden-only cases fail when the model does the forbidden thing.
    for (const f of all.filter((x) => x.expect.forbidden.length > 0)) {
      const bad = { calls: f.expect.forbidden.map((c) => ({ name: c.name, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, typeof v === "object" ? "x" : v])) })), speech: "", usage: null, model: null };
      expect(grade(f, "main", bad).pass, `${f.id} (forbidden call made)`).toBe(false);
    }
  });

  it("the state each shows has the keys and shapes the real state message has", () => {
    const real = Object.keys(
      buildState({
        now: new Date("2026-11-10T08:15:00Z"),
        callStartedAt: 0,
        session: { status: "active", outcome: null },
        fields: Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, { value: null, source: null, collectedAt: null, status: "missing", conflict: null }])) as never,
        requests: [],
        isReturningCall: true,
        lastAgentLine: "x",
        newChatEvents: [],
      }),
    );
    const optional = new Set(["lastQuestionOnPreviousCall"]);
    for (const f of all) {
      const keys = Object.keys(f.state);
      for (const key of real.filter((k) => !optional.has(k))) expect(keys, `${f.id} lacks ${key}`).toContain(key);
      for (const key of keys) expect(real, `${f.id} has an unknown key ${key}`).toContain(key);
      expect(["collecting", "submitted", "stopped"]).toContain(f.state.claimStatus);
      expect(String(f.state.localTime)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z][a-z]+day$/);
      for (const field of f.state.missing as string[]) expect(REQUIRED_RECORD_FIELDS as readonly string[], `${f.id}: ${field}`).toContain(field);
      for (const field of Object.keys(f.state.collected as object)) expect(RECORD_FIELD_IDS as readonly string[]).toContain(field);
      expect(f.state.readyToSubmit === true ? (f.state.missing as unknown[]).length : 0, f.id).toBe(0); // ready means nothing missing
    }
  });

  it("covers what the plan lists: relative dates, spoken identifiers, opt-out confirmation, the returning call, safety, injection", () => {
    const ids = all.map((f) => f.id).join(" ");
    for (const topic of ["date-", "spoken-serial", "spoken-email", "opt-out", "returning-call", "safety", "injection", "claim-already-submitted", "ready-to-submit"]) expect(ids, topic).toContain(topic);
  });

  it("the typed-note injection fixture carries the attack escaped and wrapped, as the real state message does", () => {
    const fixture = all.find((f) => f.id === "injection-in-chat-note");
    const collected = (fixture?.state.collected ?? {}) as Record<string, string>;
    const notes = String(collected.additionalNotes);
    expect(notes.startsWith('<chat_input field="additionalNotes">')).toBe(true);
    expect(notes.endsWith("</chat_input>")).toBe(true);
    expect(notes.slice('<chat_input field="additionalNotes">'.length, -"</chat_input>".length)).not.toMatch(/[<>]/);
  });
});

describe("what the model is shown", () => {
  it("is the frozen system prompt, the conversation, and the state message last", () => {
    const f = main[0] as Fixture;
    const messages = buildMessages(f);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(String(messages[0]?.content)).toContain("You are Riya");
    expect(messages.slice(1, -1).map((m) => [m.role, m.content])).toEqual(f.transcript.map((t) => [t.role, t.text]));
    expect(messages.at(-1)).toEqual({ role: "system", content: `STATE ${JSON.stringify(f.state)}` });
  });
});

describe("asking a model", () => {
  it("collects tool calls through the real validation and the speech and usage; an invalid call is not a call", async () => {
    const llm = new FakeLlm();
    llm.enqueue({
      text: "Got it.",
      toolCalls: [
        { name: "save_field", args: { field: "deviceType", value: "smartphone", spoken_evidence: "phone" } },
        { name: "save_field", args: { field: "notAField", value: "x", spoken_evidence: "x" } },
        { name: "delete_everything", args: {} },
      ],
      usage: { promptTokens: 2000, completionTokens: 50 },
    });
    const answer = await askModel(llm, main[0] as Fixture);
    expect(answer.speech).toBe("Got it.");
    expect(answer.calls).toEqual([{ name: "save_field", args: { field: "deviceType", value: "smartphone", spoken_evidence: "phone" } }, { name: "(invalid save_field)", args: {} }, { name: "(invalid delete_everything)", args: {} }]);
    expect(answer.usage).toMatchObject({ promptTokens: 2000, completionTokens: 50 });
    expect(llm.requests[0]?.tools.map((t) => t.name)).toEqual(["save_field", "request_chat_input", "flag_for_review", "opt_out", "end_call"]);
  });
});

describe("the report", () => {
  it("computes the pass rate per set, the token totals and the list-price cost from the usage the provider gave", async () => {
    const perfect = await runEval(async (f) => ({ ...referenceAnswer(f), usage: { promptTokens: 2000, completionTokens: 100, cachedTokens: 0 }, model: "openai/gpt-oss-20b" }));
    expect(perfect.passRate).toEqual({ main: 1, heldout: 1 });
    expect(perfect.cases).toEqual({ main: 20, heldout: 5 });
    expect(perfect.meetsThresholds).toBe(true);
    expect(perfect.tokens).toEqual({ prompt: 50_000, completion: 2_500, cached: 0 });
    // gpt-oss-20b: $0.075 / $0.30 per million tokens (metrics/prices.ts).
    expect(perfect.costUsd).toBeCloseTo((50_000 * 0.075 + 2_500 * 0.3) / 1_000_000, 8);

    const dry = await runEval(async (f) => referenceAnswer(f));
    expect(dry.costUsd).toBeNull(); // no usage: no cost is claimed
  });

  it("applies the gate's thresholds: ≥ 90% main and ≥ 85% held out (5 cases, so all of them)", async () => {
    expect(THRESHOLDS).toEqual({ main: 0.9, heldout: 0.85 });
    const failing = new Set(["device-type", "device-model"]); // 18/20 = 90%
    const ninety = await runEval(async (f) => (failing.has(f.id) ? { calls: [], speech: "", usage: null, model: null } : referenceAnswer(f)));
    expect(ninety.passRate.main).toBeCloseTo(0.9);
    expect(ninety.meetsThresholds).toBe(true);
    const eightyFive = await runEval(async (f) => (f.id === "heldout-hinglish-model" ? { calls: [], speech: "", usage: null, model: null } : referenceAnswer(f)));
    expect(eightyFive.passRate.heldout).toBeCloseTo(0.8); // 4/5 is below 85%
    expect(eightyFive.meetsThresholds).toBe(false);
    const three = new Set(["device-type", "device-model", "problem-description"]);
    expect((await runEval(async (f) => (three.has(f.id) ? { calls: [], speech: "", usage: null, model: null } : referenceAnswer(f)))).meetsThresholds).toBe(false);
    expect(report([]).meetsThresholds).toBe(false);
  });
});

describe("the budget guard (the real model is never called without approval)", () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [RUN, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });

  it("refuses without EVAL_BUDGET_APPROVED=1 (exit 2), even with a key set", () => {
    const result = run([], { GROQ_API_KEY: "fake-groq-key-000000000000000" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("EVAL_BUDGET_APPROVED=1");
  });

  it("with approval but no key it stops before any request (exit 2)", () => {
    const result = run([], { EVAL_BUDGET_APPROVED: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GROQ_API_KEY is not set");
  });

  it("--dry needs neither, says it measures no model, and exits 0", () => {
    const result = run(["--dry"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("this does not measure any model");
    expect(result.stdout).toContain("main 100% (20 cases");
  });
});
