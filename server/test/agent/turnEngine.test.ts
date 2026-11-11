// The turn engine (P5-T06) with the scripted fake LLM and a recording tool runner: text only; text + a valid tool;
// tools only → acknowledge-then-ask; an invalid result → a follow-up; malformed tool JSON; the last-resort route;
// every route failing; tools run exactly once; the round limit; abort.
import { describe, expect, it } from "vitest";
import type { ParsedToolCall } from "../../src/agent/tools.js";
import { FILLER_LINE, MAX_ROUNDS, ONE_MOMENT, runTurn, type ToolOutcome } from "../../src/agent/turnEngine.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { LlmError, type LlmMessage } from "../../src/voice/types.js";

function setup(outcomes: (call: ParsedToolCall) => ToolOutcome = () => ({ result: { status: "valid" }, ok: true, ack: "Got it." })) {
  const llm = new FakeLlm();
  const ran: ParsedToolCall[] = [];
  const said: string[] = [];
  let states = 0;
  const go = (signal?: AbortSignal) =>
    runTurn(
      {
        llm,
        tools: {
          run: async (call) => {
            ran.push(call);
            return outcomes(call);
          },
        },
      },
      { history: [{ role: "system", content: "prompt" }, { role: "user", content: "hi" }], state: async () => ({ role: "system", content: `STATE ${++states}` }), signal },
      { say: (text) => said.push(text) },
    );
  return { llm, ran, said, go, states: () => states };
}
const save = (field: string, value: string) => ({ name: "save_field", args: { field, value, spoken_evidence: value } });

describe("runTurn", () => {
  it("text only: streamed to the sink in order, one model call, recorded as the agent's message", async () => {
    const t = setup();
    t.llm.enqueue({ text: "Hi! I'm Riya. What device is it?", pieceChars: 5 });
    const out = await t.go();
    expect(t.said.join("")).toBe("Hi! I'm Riya. What device is it?");
    expect(t.said.length).toBeGreaterThan(3);
    expect(out).toMatchObject({ spoken: "Hi! I'm Riya. What device is it?", failed: false, endCall: false, rounds: [{ route: { provider: "groq" } }] });
    expect(out.messages).toEqual([{ role: "assistant", content: "Hi! I'm Riya. What device is it?" }]);
    expect(t.llm.requests).toHaveLength(1);
    expect((t.llm.requests[0]?.messages.at(-1) as LlmMessage | undefined)?.content).toBe("STATE 1"); // state last
  });

  it("text + a valid tool: the tool runs once, its result goes back, and there's no follow-up", async () => {
    const t = setup();
    t.llm.enqueue({ text: "Got it, a Samsung. When did it start?", toolCalls: [save("deviceModel", "Samsung Galaxy S23")] });
    const out = await t.go();
    expect(t.ran.map((c) => c.name)).toEqual(["save_field"]);
    expect(t.llm.requests).toHaveLength(1);
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(out.messages[1]).toMatchObject({ role: "tool", content: JSON.stringify({ status: "valid" }) });
  });

  it("tools only → the templated acknowledgement is spoken at once, then the follow-up asks the next question", async () => {
    const t = setup((call) => ({ result: { status: "valid" }, ok: true, ack: call.name === "save_field" && call.args.field === "deviceModel" ? "Got it, Samsung Galaxy S23." : "Got it." }));
    t.llm.enqueue({ toolCalls: [save("deviceModel", "Samsung Galaxy S23")] }, { text: "When did the problem start?" });
    const out = await t.go();
    expect(t.said).toEqual(["Got it, Samsung Galaxy S23.", " When did the problem start?"]);
    expect(out.spoken).toBe("Got it, Samsung Galaxy S23. When did the problem start?");
    expect(t.llm.requests).toHaveLength(2);
    // The acknowledgement is in the history as the agent's words, before the tool results.
    expect(out.messages[0]).toMatchObject({ role: "assistant", content: "Got it, Samsung Galaxy S23." });
    expect(t.states()).toBe(2); // a fresh state for the follow-up
  });

  it("one field per call (seen with gpt-oss-20b): several rounds, each acknowledged once, until the model speaks", async () => {
    const t = setup((call) => ({ result: { status: "valid" }, ok: true, ack: `Noted ${(call as { args: { field: string } }).args.field}.` }));
    t.llm.enqueue({ toolCalls: [save("deviceType", "smartphone")] }, { toolCalls: [save("deviceModel", "Samsung Galaxy S23")] }, { text: "What's wrong with it?" });
    const out = await t.go();
    expect(t.ran).toHaveLength(2);
    expect(out.spoken).toBe("Noted deviceType. Noted deviceModel. What's wrong with it?");
  });

  it("an invalid result → no acknowledgement and a follow-up so the agent can ask again", async () => {
    const t = setup(() => ({ result: { status: "invalid", error: "That date is in the future." }, ok: false }));
    t.llm.enqueue({ toolCalls: [save("problemStartedAt", "tomorrow")] }, { text: "Sorry, when did it start?" });
    const out = await t.go();
    expect(out.spoken).toBe("Sorry, when did it start?");
    expect(t.llm.requests).toHaveLength(2);
    expect(out.messages[1]).toMatchObject({ role: "tool", content: JSON.stringify({ status: "invalid", error: "That date is in the future." }) });
  });

  it("malformed tool JSON or an unknown tool gets an error result, no effect, and a follow-up", async () => {
    const t = setup();
    t.llm.enqueue({ toolCalls: [{ name: "save_field", args: "{broken" }, { name: "launch_rocket", args: {} }] }, { text: "Could you repeat that?" });
    const out = await t.go();
    expect(t.ran).toEqual([]);
    expect(out.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content).status)).toEqual(["error", "error"]);
    expect(out.spoken).toBe("Could you repeat that?");
  });

  it("each tool runs exactly once, even across rounds", async () => {
    const t = setup();
    t.llm.enqueue({ toolCalls: [save("deviceType", "laptop"), { name: "request_chat_input", args: { field: "serialNumber" } }] }, { text: "Anything else?" });
    await t.go();
    expect(t.ran.map((c) => c.name)).toEqual(["save_field", "request_chat_input"]);
  });

  it("falling back to the last resort (Gemini) says 'One moment.' while it works (before its answer); other routes don't", async () => {
    const t = setup();
    t.llm.enqueue({ text: "Which model is it?", route: { provider: "gemini", model: "gemini-flash-lite-latest" }, fellBack: true });
    expect((await t.go()).spoken).toBe(`${ONE_MOMENT} Which model is it?`);
    t.llm.enqueue({ text: "Which model is it?", route: { provider: "groq", model: "openai/gpt-oss-120b" }, fellBack: true });
    expect((await t.go()).spoken).toBe("Which model is it?");
  });

  it("every route failing → the filler line, marked failed; empty output also counts as refused", async () => {
    const t = setup();
    t.llm.enqueue({ error: new LlmError("all routes failed", 503) });
    expect(await t.go()).toMatchObject({ spoken: FILLER_LINE, failed: true, refused: false });
    t.llm.enqueue({ error: new LlmError("empty", "empty") });
    expect(await t.go()).toMatchObject({ failed: true, refused: true });
  });

  it("end_call (or an opt-out) ends the turn: no follow-up", async () => {
    const t = setup((call) => ({ result: { status: "ending" }, ok: true, endCall: call.name === "end_call" }));
    t.llm.enqueue({ text: "Thanks, goodbye!", toolCalls: [{ name: "end_call", args: {} }] }, { text: "should not run" });
    const out = await t.go();
    expect(out.endCall).toBe(true);
    expect(t.llm.requests).toHaveLength(1);
  });

  it("stops after MAX_ROUNDS model calls even if the model never speaks", async () => {
    const t = setup(() => ({ result: { status: "valid" }, ok: true }));
    for (let i = 0; i < MAX_ROUNDS + 2; i++) t.llm.enqueue({ toolCalls: [save("deviceType", "laptop")] });
    await t.go();
    expect(t.llm.requests).toHaveLength(MAX_ROUNDS);
  });

  it("an abort (barge-in) stops mid-stream and keeps only what was streamed", async () => {
    const t = setup();
    const controller = new AbortController();
    let n = 0;
    t.llm.enqueue({ text: "One. Two. Three. Four.", pieceChars: 5, gate: async () => void (++n === 2 && controller.abort()) });
    const out = await t.go(controller.signal);
    expect(out.aborted).toBe(true);
    expect(out.spoken).toBe("One. ");
  });
});

describe("no double acknowledgement (seen in a real gpt-oss-20b call)", () => {
  it("a follow-up that starts by repeating the spoken acknowledgement has that part dropped, even split across pieces", async () => {
    const t = setup(() => ({ result: { status: "valid" }, ok: true, ack: "Got it." }));
    t.llm.enqueue({ toolCalls: [save("deviceType", "smartphone")] }, { text: "Got it. Could you tell me the brand and model?", pieceChars: 3 });
    const out = await t.go();
    expect(out.spoken).toBe("Got it. Could you tell me the brand and model?");
    expect(t.said.join("")).toBe("Got it. Could you tell me the brand and model?");
    expect(out.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Got it.", "Could you tell me the brand and model?"]);
  });

  it("a follow-up that only starts the same way is spoken in full", async () => {
    const t = setup(() => ({ result: { status: "valid" }, ok: true, ack: "Got it." }));
    t.llm.enqueue({ toolCalls: [save("deviceType", "smartphone")] }, { text: "Got itchy fingers? Which model is it?", pieceChars: 4 });
    const out = await t.go();
    expect(out.spoken).toBe("Got it. Got itchy fingers? Which model is it?");
  });

  // Live session ed7ce483 (2026-11-11): the reply broke after "When did" and the call sat silent until the user left.
  it("a stream that breaks mid-sentence gets one more round, told where it was cut off", async () => {
    const t = setup();
    t.llm.enqueue({ text: "I'm sorry to hear that. When did", pieceChars: 8, breakAfter: 3 }, { text: "the screen crack?" });
    const out = await t.go();
    expect(t.llm.requests).toHaveLength(2);
    const hint = t.llm.requests[1]?.messages.find((m) => m.role === "system" && String(m.content).includes("cut off"));
    expect(hint).toBeDefined();
    expect(out.failed).toBe(false);
    expect(out.spoken).toContain("the screen crack?");
  });

  it("a stream that breaks twice stops after one retry and the call carries on", async () => {
    const t = setup();
    t.llm.enqueue({ text: "When did it start", pieceChars: 4, breakAfter: 2 }, { text: "Sorry, one more", pieceChars: 4, breakAfter: 1 });
    const out = await t.go();
    expect(t.llm.requests).toHaveLength(2);
    expect(out.aborted).toBe(false);
  });

  // Same session: the model asked for the brand and model three times in one turn, because a failed tool call after it
  // had already spoken started another round that spoke again.
  it("a quiet rejection after the model already spoke does not start a second round that asks again", async () => {
    const t = setup(() => ({ result: { status: "rejected" }, ok: false, quiet: true }));
    t.llm.enqueue({ text: "What's the brand and model?", toolCalls: [save("deviceModel", "x")] }, { text: "Could you tell me the brand and model?" });
    const out = await t.go();
    expect(t.llm.requests).toHaveLength(1);
    expect(out.spoken).toBe("What's the brand and model?");
  });

  it("a real invalid value still gets a follow-up so the agent can react", async () => {
    const t = setup(() => ({ result: { status: "invalid", error: "which date?" }, ok: false }));
    t.llm.enqueue({ text: "Thanks.", toolCalls: [save("problemStartedAt", "soon")] }, { text: "Roughly which date was that?" });
    await t.go();
    expect(t.llm.requests).toHaveLength(2);
  });
});
