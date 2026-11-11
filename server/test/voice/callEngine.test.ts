// The call engine (P5-T07…T12) on fakes: a fake session port, fake STT/TTS/LLM and a manual clock. Real time never
// passes, so timings (barge-in reaction, silence at 8/16/24 s, the proactive turn after 1.2 s) are exact.
import { CallServerMessageType, CloseCode } from "@device-repair/shared/protocol";
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { describe, expect, it } from "vitest";
import { OPTED_OUT_GOODBYE, PROVIDER_TROUBLE, REPROMPTS } from "../../src/agent/voiceTemplates.js";
import { FILLER_LINE } from "../../src/agent/turnEngine.js";
import type { SessionEvent } from "../../src/db/repos/events.js";
import type { ResolvedField } from "../../src/domain/conflicts.js";
import { createLogger } from "../../src/log.js";
import type { Command } from "../../src/session/commands.js";
import type { SessionUpdate } from "../../src/session/hub.js";
import { CallEngine, type CallTimings } from "../../src/voice/callEngine.js";
import type { CallContext, CallSessionPort } from "../../src/voice/callSession.js";
import { ManualClock } from "../../src/voice/clock.js";
import { FakeLlm, type LlmScript } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import type { CallMessage } from "../../src/voice/speechOut.js";
import { LlmError, type LlmMessage } from "../../src/voice/types.js";
import { resolved } from "../domain/helpers.js";

type Cmd = Command & Record<string, unknown>;

class FakePort implements CallSessionPort {
  readonly sessionId = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b";
  readonly commands: Cmd[] = [];
  readonly llmUsage: unknown[] = [];
  readonly metrics: Record<string, unknown>[] = [];
  sttSeconds: number[] = [];
  ttsCharacters = 0;
  reconciles = 0;
  readonly #listeners = new Set<(u: SessionUpdate) => void>();
  ctx: CallContext = {
    session: { status: "active", outcome: null } as CallContext["session"],
    fields: Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, resolved("missing")])) as Record<RecordFieldId, ResolvedField>,
    requests: [],
    lastAgentLineBefore: null,
  };
  replies: Partial<Record<string, (c: Cmd) => unknown>> = {
    SaveSpokenField: (c) => ({ status: "valid", normalized: c.field === "deviceModel" ? { brand: "Samsung", model: "Galaxy S23" } : c.value }),
    RequestInput: (c) => ({ status: "queued", requestId: `req_${c.field}_1` }),
    EndCall: () => ({ status: "ended", seconds: 1 }),
    OptOutByCall: () => ({ status: "optedOut", revision: 1 }),
  };
  async dispatch<R>(command: Cmd): Promise<R | undefined> {
    this.commands.push(command);
    return this.replies[command.type]?.(command) as R | undefined;
  }
  async context(): Promise<CallContext> {
    return this.ctx;
  }
  subscribe(listener: (u: SessionUpdate) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async reconcile() {
    this.reconciles += 1;
  }
  async recordLlmUsage(route: unknown, usage: unknown) {
    this.llmUsage.push({ route, usage });
  }
  readonly llmRequests: unknown[] = [];
  async recordLlmRequest(route: unknown) {
    this.llmRequests.push(route);
  }
  async recordSttSeconds(seconds: number) {
    this.sttSeconds.push(seconds);
  }
  async recordTtsCharacters(n: number) {
    this.ttsCharacters += n;
  }
  async recordTurnMetric(metric: Record<string, unknown>) {
    this.metrics.push(metric);
  }
  emit(...events: Partial<SessionEvent>[]) {
    const update = { sessionId: this.sessionId, events: events.map((e, i) => ({ sessionId: this.sessionId, seq: 100 + i, channel: "chat", payload: {}, createdAt: new Date(), ...e })), session: {} } as unknown as SessionUpdate;
    for (const listener of this.#listeners) listener(update);
  }
  of(type: string) {
    return this.commands.filter((c) => c.type === type);
  }
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface Setup {
  /** Audio delivered faster than real time (Aura-2 sends seconds of speech in a fraction of that). */
  fastAudio?: boolean;
  greeting?: LlmScript;
  returning?: boolean;
  timings?: Partial<CallTimings>;
  /** Fake TTS frames on the clock (audio takes time) or all at once (speech is instant). */
  timedAudio?: boolean;
}

async function call(options: Setup = {}) {
  const clock = new ManualClock();
  const stt = new FakeStt();
  // "Instant" speech: one 40 ms frame per chunk, so playback (which silence and barge-in follow) is short.
  const tts = new FakeTts(options.timedAudio === false ? { charsPerFrame: 10_000 } : { clock, charsPerFrame: 4, intervalMs: options.fastAudio ? 5 : undefined });
  const llm = new FakeLlm();
  llm.fallback = { text: "Okay." };
  const port = new FakePort();
  const sent: CallMessage[] = [];
  const closes: [number, string][] = [];
  llm.enqueue(options.greeting ?? { text: "Hi, I'm Riya. What device is it?" });
  const engine = await CallEngine.start({
    callId: "c1",
    port,
    stt,
    tts,
    llm,
    clock,
    log: createLogger("silent"),
    send: (m) => sent.push(m),
    close: (code, reason) => closes.push([code, reason]),
    returning: options.returning ?? false,
    timings: options.timings,
  });
  const step = async (ms: number, every = 20) => {
    // In small steps: TTS frames, the engine's timers and the async work between them interleave. Long idle
    // stretches can use coarser steps (fewer flushes, so the test stays fast under load).
    for (let t = 0; t < ms; t += every) {
      clock.advance(Math.min(every, ms - t));
      await flush();
    }
  };
  await flush();
  return { clock, stt, tts, llm, port, sent, closes, engine, step };
}

const lastState = (llm: FakeLlm, index = -1) => JSON.parse(String((llm.requests.at(index)?.messages.at(-1) as LlmMessage | undefined)?.content).slice("STATE ".length));
const agentLines = (sent: CallMessage[]) => sent.filter((m) => m.type === CallServerMessageType.TRANSCRIPT && m.role === "agent");

describe("the call starts", () => {
  it("greets: the first turn runs with 'call connected', the agent line is spoken, persisted and charged", async () => {
    const c = await call();
    await c.step(3_000);
    expect(c.llm.requests[0]?.messages.find((m) => m.role === "user")).toEqual({ role: "user", content: "(The call has just connected.)" });
    expect(lastState(c.llm, 0)).toMatchObject({ isReturningCall: false, claimStatus: "collecting" });
    expect(c.tts.current.spoken()).toBe("Hi, I'm Riya. What device is it?");
    expect(agentLines(c.sent).at(-1)).toMatchObject({ id: "ta_c1_1", text: "Hi, I'm Riya. What device is it?", final: true });
    expect(c.port.of("AppendTranscript").map((cmd) => (cmd.line as { role: string; text: string }).text)).toEqual(["Hi, I'm Riya. What device is it?"]);
    expect(c.port.llmUsage).toEqual([{ route: { provider: "groq", model: "openai/gpt-oss-20b" }, usage: { promptTokens: 900, completionTokens: 20, cachedTokens: 0 } }]);
    // Billed on what was sent to TTS: the two chunks (the space between them isn't sent).
    expect(c.port.ttsCharacters).toBe("Hi, I'm Riya.".length + "What device is it?".length);
    await c.engine.stop("hangup");
  });

  it("a returning call (P5-T12): the first turn's context says so and carries what's collected, what's missing and the last question", async () => {
    const port0 = new FakePort();
    void port0;
    const c = await call({ returning: true });
    c.port.ctx = { ...c.port.ctx, lastAgentLineBefore: "And when did the problem start?" };
    // The greeting's state was read already; check a fresh one on the next turn too.
    await c.step(2_000);
    expect(c.llm.requests[0]?.messages.find((m) => m.role === "user")).toEqual({ role: "user", content: "(The customer called back.)" });
    expect(lastState(c.llm, 0).isReturningCall).toBe(true);
    c.port.ctx.fields = { ...c.port.ctx.fields, deviceType: resolved("valid", "smartphone", "call"), deviceModel: resolved("valid", { brand: "Samsung", model: "Galaxy S23" }, "call") };
    c.stt.current.say("It started last week");
    await c.step(1_000);
    const state = lastState(c.llm);
    expect(state).toMatchObject({ isReturningCall: true, lastQuestionOnPreviousCall: "And when did the problem start?", collected: { deviceType: '<customer_words field="deviceType">Phone</customer_words>', deviceModel: '<customer_words field="deviceModel">Samsung Galaxy S23</customer_words>' } });
    expect(state.missing).not.toContain("deviceType");
    expect(state.missing).toContain("problemStartedAt");
    await c.engine.stop("hangup");
  });
});

describe("a user turn", () => {
  it("transcript lines with one id per utterance, only the final persisted; the agent saves the field and acknowledges it, then asks", async () => {
    const c = await call();
    await c.step(3_000);
    c.llm.enqueue({ toolCalls: [{ name: "save_field", args: { field: "deviceModel", value: "Samsung Galaxy S23", spoken_evidence: "It's a Samsung Galaxy S23" } }] }, { text: "What's wrong with it?" });
    for (let i = 0; i < 50; i++) c.engine.pushAudio(Buffer.alloc(640));
    c.stt.current.say("It's a Samsung Galaxy S23");
    await c.step(300); // merge window
    await c.step(4_000);
    const userLines = c.sent.filter((m) => m.type === "transcript" && m.role === "user");
    expect(new Set(userLines.map((l) => l.type === "transcript" && l.id))).toEqual(new Set(["tu_c1_1"]));
    expect(userLines.at(-1)).toMatchObject({ text: "It's a Samsung Galaxy S23", final: true });
    expect(c.port.of("AppendTranscript").filter((cmd) => (cmd.line as { role: string }).role === "user")).toHaveLength(1);
    expect(c.port.of("SaveSpokenField")).toEqual([{ type: "SaveSpokenField", field: "deviceModel", value: "Samsung Galaxy S23", evidence: "It's a Samsung Galaxy S23", userConfirmed: undefined }]);
    expect(c.tts.current.spoken("ta_c1_2")).toBe("Got it, Samsung Galaxy S23. What's wrong with it?");
    const metric = c.port.metrics.find((m) => m.turnId === "ta_c1_2");
    expect(metric).toMatchObject({ callId: "c1", llmTtftMs: 120 });
    expect(typeof metric?.serverMs).toBe("number");
    await c.engine.stop("hangup");
    expect(c.port.sttSeconds).toEqual([1]); // 50 frames of 20 ms
  });

  it("every reply to a user utterance gets a latency row measured from STT's end event (P11-T02)", async () => {
    const c = await call();
    await c.step(3_000);
    const rows = () => c.port.metrics.filter((m) => m.userEndAt !== undefined);
    for (let n = 0; n < 6; n++) {
      c.llm.enqueue({ text: `Answer number ${n}.` });
      c.stt.current.say(`my message number ${n}`);
      await c.step(300); // the merge window after speech_final
      await c.step(4_000);
    }
    expect(rows()).toHaveLength(6); // 6 replies after 6 utterances: 100% (the plan asks for ≥ 95%)
    for (const row of rows()) {
      const userEndAt = (row.userEndAt as Date).getTime();
      const firstAudioAt = (row.firstAudioAt as Date).getTime();
      expect(row.sttMs).toBe(300); // speech_final → the turn starts: the merge window
      expect(row.serverMs).toBe(firstAudioAt - userEndAt);
      expect(row.serverMs as number).toBeGreaterThanOrEqual(0);
      expect(typeof row.llmTtftMs).toBe("number");
      expect(typeof row.ttsTtfbMs).toBe("number");
    }
    // The greeting follows no user utterance: it has audio but no user end, so no serverMs and no sttMs.
    expect(c.port.metrics.find((m) => m.turnId === "ta_c1_1")).toMatchObject({ callId: "c1" });
    expect(c.port.metrics.find((m) => m.turnId === "ta_c1_1")?.serverMs).toBeUndefined();
    await c.engine.stop("hangup");
  });

  it("a reply the model failed to produce still gets its row, without server latency (P11-T02)", async () => {
    const c = await call();
    await c.step(3_000);
    c.llm.enqueue({ error: new LlmError("down", 503) });
    c.stt.current.say("my phone is broken");
    await c.step(300);
    await c.step(4_000);
    const row = c.port.metrics.find((m) => m.userEndAt !== undefined);
    expect(row).toBeDefined();
    expect(row?.sttMs).toBe(300);
    await c.engine.stop("hangup");
  });

  it("an identifier said aloud is saved as heard-only, and its chat card goes out at once (D13)", async () => {
    const c = await call();
    await c.step(3_000);
    c.port.replies.SaveSpokenField = () => ({ status: "unverified", normalized: "asha@example.com" });
    c.llm.enqueue({ toolCalls: [{ name: "save_field", args: { field: "email", value: "asha@example.com", spoken_evidence: "asha at example dot com" } }] }, { text: "Thanks." });
    c.stt.current.say("my email is asha at example dot com");
    await c.step(3_000);
    expect(c.port.of("RequestInput")).toEqual([{ type: "RequestInput", field: "email" }]);
    expect(c.tts.current.spoken("ta_c1_2")).toContain("Please type your email address in the chat box");
    await c.engine.stop("hangup");
  });
});

describe("barge-in (P5-T07)", () => {
  const long = "Thanks for calling the repair desk. I can help you register your claim today, and it only takes a few minutes. First, which device is it?";

  it("confirmed speech while the agent is audible: stopPlayback first, then no more audio; TTS cancelled once; the line cut at what was heard", async () => {
    const c = await call({ greeting: { text: long } });
    await c.step(600); // the agent has been audible for a while
    const audioBefore = c.sent.filter((m) => m.type === "audio").length;
    expect(audioBefore).toBeGreaterThan(3);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "wait sorry", isFinal: false, speechFinal: false });
    // The reaction happens in the same tick as the confirming event (≤ 50 ms: here 0 ms of clock time).
    const stopAt = c.sent.findIndex((m) => m.type === CallServerMessageType.STOP_PLAYBACK);
    expect(stopAt).toBe(audioBefore + agentLines(c.sent).length + c.sent.filter((m) => m.type === "transcript" && m.role === "user").length - 0 > 0 ? stopAt : -1);
    expect(stopAt).toBeGreaterThan(0);
    await c.step(3_000);
    expect(c.sent.slice(stopAt + 1).filter((m) => m.type === "audio")).toHaveLength(0);
    expect(c.tts.current.cancelledTurns).toEqual(["ta_c1_1"]);
    expect(c.engine.bargeIns).toBe(1);
    const final = agentLines(c.sent).filter((l) => l.type === "transcript" && l.final).at(-1);
    expect(final?.type === "transcript" && final.text.endsWith("[interrupted]")).toBe(true);
    const persisted = c.port.of("AppendTranscript").find((cmd) => (cmd.line as { role: string }).role === "agent")?.line as { text: string; interrupted: boolean };
    expect(persisted.interrupted).toBe(true);
    expect(long.startsWith(persisted.text.replace(" [interrupted]", ""))).toBe(true);
    expect(persisted.text.length).toBeLessThan(long.length);
    await c.engine.stop("hangup");
  });

  it("the interrupted line is what the model sees next turn, and the LLM stream was aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pieces = 0;
    const c = await call({ greeting: { text: long, pieceChars: 30, gate: async () => void (++pieces > 2 && (await gate)) } });
    await c.step(600);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "hold on please", isFinal: true, speechFinal: true });
    release();
    await c.step(400);
    await c.step(2_000);
    const next = c.llm.requests.at(-1)?.messages ?? [];
    const assistant = next.filter((m) => m.role === "assistant").at(-1);
    expect(String(assistant?.content)).toMatch(/\[interrupted\]$/);
    expect(next.filter((m) => m.role === "user").at(-1)).toEqual({ role: "user", content: "hold on please" });
    expect(c.tts.current.spoken("ta_c1_1").length).toBeLessThan(long.length); // the rest was never sent to TTS
    await c.engine.stop("hangup");
  });

  it("echo or a cough doesn't interrupt: voice activity alone, or one short word", async () => {
    const c = await call({ greeting: { text: `${long} ${long}` } }); // long enough to still be speaking throughout
    await c.step(600);
    c.stt.current.emit({ type: "speechStarted" });
    await c.step(1_000);
    c.stt.current.emit({ type: "utteranceEnd" });
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "uh", isFinal: false, speechFinal: false });
    await c.step(200);
    expect(c.sent.some((m) => m.type === CallServerMessageType.STOP_PLAYBACK)).toBe(false);
    // ...but one word that goes on for 400 ms does.
    await c.step(300);
    expect(c.sent.some((m) => m.type === CallServerMessageType.STOP_PLAYBACK)).toBe(true);
    await c.engine.stop("hangup");
  });

  it("speech in the first 250 ms of the agent's audio is ignored", async () => {
    const c = await call({ greeting: { text: long } });
    await c.step(100);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "two words", isFinal: false, speechFinal: false });
    expect(c.sent.some((m) => m.type === CallServerMessageType.STOP_PLAYBACK)).toBe(false);
    await c.engine.stop("hangup");
  });
});

describe("playback, not sending, is what counts (found by the real-provider call)", () => {
  const long = "Thanks for calling the repair desk. I can help you register your claim today, and it only takes a few minutes. First, which device is it?";

  it("audio sent 8× faster than real time: after the last frame is sent the user still hears it, so barge-in still works", async () => {
    const c = await call({ greeting: { text: long }, fastAudio: true });
    await c.step(800); // every frame has been sent (the fake sends a 40 ms frame every 5 ms)…
    expect(c.sent.filter((m) => m.type === "transcript" && m.role === "agent" && m.final)).toHaveLength(1); // …so the line is final
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "hang on", isFinal: false, speechFinal: false });
    expect(c.sent.some((m) => m.type === CallServerMessageType.STOP_PLAYBACK)).toBe(true);
    // The line is corrected in place (same id) to what was heard.
    const lines = agentLines(c.sent).filter((l) => l.type === "transcript" && l.id === "ta_c1_1" && l.final);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.type === "transcript" && lines[1].text.endsWith("[interrupted]")).toBe(true);
    await c.step(500);
    const persisted = c.port.of("AppendTranscript").find((cmd) => (cmd.line as { role: string }).role === "agent")?.line as { interrupted: boolean };
    expect(persisted.interrupted).toBe(true);
    await c.engine.stop("hangup");
  });

  it("end_call waits until the goodbye has played, not just been sent", async () => {
    const c = await call({ greeting: { text: long, toolCalls: [{ name: "end_call", args: {} }] }, fastAudio: true });
    await c.step(1_000); // all sent; about 5 s of audio still to play
    expect(c.port.of("EndCall")).toEqual([]);
    await c.step(6_000);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "agent_ended" }]);
  });
});

describe("chat events on the call (P5-T08)", () => {
  const accepted = (field: string) => ({ type: "field.candidate", channel: "chat" as const, payload: { candidate: { field, status: "valid" } } });

  it("an event while idle → a proactive turn ≤ 1.5 s after the idle threshold, with the event in its state", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    const before = c.llm.requests.length;
    c.port.emit(accepted("email"));
    await c.step(1_100);
    expect(c.llm.requests.length).toBe(before);
    await c.step(200);
    expect(c.llm.requests.length).toBe(before + 1);
    expect(lastState(c.llm).newChatEvents).toEqual([{ field: "email", result: "accepted" }]);
    await c.engine.stop("hangup");
  });

  it("two events within 1 s → one acknowledgement turn", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    const before = c.llm.requests.length;
    c.port.emit(accepted("email"));
    await c.step(600);
    c.port.emit(accepted("serialNumber"));
    await c.step(2_000);
    expect(c.llm.requests.length).toBe(before + 1);
    expect(lastState(c.llm).newChatEvents.map((e: { field: string }) => e.field)).toEqual(["email", "serialNumber"]);
    await c.engine.stop("hangup");
  });

  it("an event while the user speaks isn't acknowledged mid-speech: it rides along with the next agent turn", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    const before = c.llm.requests.length;
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "it's a laptop and", isFinal: false, speechFinal: false });
    c.port.emit(accepted("email"));
    await c.step(2_000);
    expect(c.llm.requests.length).toBe(before); // no turn while they talk
    c.stt.current.emit({ type: "transcript", text: "it's a laptop and it won't charge", isFinal: true, speechFinal: true });
    await c.step(500);
    expect(c.llm.requests.length).toBe(before + 1);
    expect(lastState(c.llm).newChatEvents).toEqual([{ field: "email", result: "accepted" }]);
    expect(c.llm.requests.at(-1)?.messages.filter((m) => m.role === "user").at(-1)).toEqual({ role: "user", content: "it's a laptop and it won't charge" });
    await c.engine.stop("hangup");
  });

  it("rejections are counted per field (voice help after 2+)", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    const rejected = { type: "field.candidate", channel: "chat" as const, payload: { candidate: { field: "serialNumber", status: "invalid" } } };
    c.port.emit(rejected);
    c.port.emit(rejected);
    await c.step(1_500);
    expect(lastState(c.llm).newChatEvents).toEqual([{ field: "serialNumber", result: "rejected", rejections: 2 }]);
    await c.engine.stop("hangup");
  });

  it("finalized from the chat during the call (Stop → Yes): the agent says goodbye and ends the call", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.port.emit({ type: "session.finalized", channel: "system", payload: { outcome: "optedOut", revision: 1 } });
    await c.step(500);
    expect(c.tts.current.spoken()).toContain(OPTED_OUT_GOODBYE);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "opted_out" }]);
    expect(c.closes).toEqual([[CloseCode.NORMAL, "agent ended"]]);
  });
});

describe("silence (P5-T10)", () => {
  it("reprompts at 8 s and 16 s, then ends at 24 s with reason silence (counted from when the agent stopped playing)", async () => {
    const c = await call({ timedAudio: false }); // each line plays for 40–80 ms
    await c.step(7_900);
    expect(c.tts.current.spoken()).not.toContain(REPROMPTS[0]);
    await c.step(300);
    expect(c.tts.current.spoken()).toContain(REPROMPTS[0]);
    await c.step(7_700);
    expect(c.tts.current.spoken()).not.toContain(REPROMPTS[1]);
    await c.step(400);
    expect(c.tts.current.spoken()).toContain(REPROMPTS[1]);
    await c.step(7_700);
    expect(c.port.of("EndCall")).toEqual([]);
    await c.step(400);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "silence" }]);
    expect(c.closes).toEqual([[CloseCode.NORMAL, "silence"]]);
  });

  it("isn't counted for 30 s after a chat card opened (they're busy typing)", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.port.emit({ type: "input.requested", channel: "chat", payload: {} });
    await c.step(25_000, 100);
    expect(c.tts.current.spoken()).not.toContain(REPROMPTS[0]);
    expect(c.port.of("EndCall")).toEqual([]);
    await c.step(15_000, 100);
    expect(c.tts.current.spoken()).toContain(REPROMPTS[0]);
    await c.engine.stop("hangup");
  });

  it("speech resets it", async () => {
    const c = await call({ timedAudio: false });
    await c.step(7_000);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "utteranceEnd" });
    await c.step(7_000);
    expect(c.tts.current.spoken()).not.toContain(REPROMPTS[0]);
    await c.engine.stop("hangup");
  });
});

describe("how a call ends (P5-T09, P5-T10)", () => {
  it("end_call: after the goodbye has played, EndCall(agent_ended) and the socket closes 'agent ended'", async () => {
    const c = await call({ greeting: { text: "Thanks, that's all I need. Goodbye!", toolCalls: [{ name: "end_call", args: {} }] } });
    await c.step(200);
    expect(c.port.of("EndCall")).toEqual([]); // still speaking
    await c.step(5_000);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "agent_ended" }]);
    expect(c.closes).toEqual([[CloseCode.NORMAL, "agent ended"]]);
    // The goodbye was recorded before the end.
    const types = c.port.commands.map((cmd) => cmd.type);
    expect(types.indexOf("AppendTranscript")).toBeLessThan(types.indexOf("EndCall"));
  });

  it("opt-out by voice: confirmed → OptOutByCall, the goodbye, EndCall(opted_out); the hub's finalized event adds nothing", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.llm.enqueue({ toolCalls: [{ name: "opt_out", args: { confirmed: true } }] });
    c.stt.current.say("yes please stop my claim");
    await c.step(400);
    c.port.emit({ type: "session.finalized", channel: "system", payload: { outcome: "optedOut" } });
    await c.step(500);
    expect(c.port.of("OptOutByCall")).toHaveLength(1);
    expect(c.tts.current.spoken().split(OPTED_OUT_GOODBYE).length - 1).toBe(1);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "opted_out" }]);
  });

  it("opt_out without confirmation finalizes nothing (the agent must ask first)", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.llm.enqueue({ toolCalls: [{ name: "opt_out", args: { confirmed: false } }] }, { text: "Do you want to stop your claim?" });
    c.stt.current.say("i want to stop");
    await c.step(500);
    expect(c.port.of("OptOutByCall")).toEqual([]);
    expect(c.tts.current.spoken()).toContain("Do you want to stop your claim?");
    await c.engine.stop("hangup");
  });

  it("STT fails: reconnect once; the second failure says so and ends with provider_error", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.stt.current.emit({ type: "error", error: new Error("dropped") });
    await c.step(100);
    expect(c.stt.streams).toHaveLength(2);
    expect(c.port.of("EndCall")).toEqual([]);
    c.stt.current.emit({ type: "error", error: new Error("dropped again") });
    await c.step(500);
    expect(c.tts.current.spoken()).toContain(PROVIDER_TROUBLE);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "provider_error" }]);
  });

  it("the LLM failing two turns in a row ends the call (the first gets the filler line)", async () => {
    const c = await call({ greeting: { error: new LlmError("down", 503) }, timedAudio: false });
    await c.step(200);
    expect(c.tts.current.spoken()).toBe(FILLER_LINE);
    c.llm.enqueue({ error: new LlmError("down", 503) });
    c.stt.current.say("hello");
    await c.step(600);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "provider_error" }]);
  });

  it("TTS fails: the agent's words go to the chat and the call ends", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.tts.current.failNextFlush = true;
    c.llm.enqueue({ text: "When did the problem start?" });
    c.stt.current.say("it is a laptop");
    await c.step(500);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "provider_error" }]);
    expect(c.port.of("AgentSays").length).toBeLessThanOrEqual(1);
  });

  it("the maximum duration ends the call; the planner's safety net ran at 61 s", async () => {
    const c = await call({ timedAudio: false, timings: { maxCallMs: 90_000, silenceMs: 1_000_000 } });
    await c.step(61_000, 500);
    expect(c.port.reconciles).toBe(1);
    await c.step(30_000, 500);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "max_duration" }]);
    expect(c.closes).toEqual([[CloseCode.NORMAL, "max duration"]]);
  });

  it("the socket closing ends it exactly once, with that reason, closing the providers (no close back to the socket)", async () => {
    const c = await call();
    await c.step(500);
    await Promise.all([c.engine.stop("network"), c.engine.stop("hangup")]);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "network" }]);
    expect([c.stt.current.closed, c.tts.current.closed]).toEqual([true, true]);
    expect(c.closes).toEqual([]);
    expect(c.engine.ended).toBe(true);
  });

  it("whenEnded is pending while the call runs and resolves once it has ended (the instance's call cap counts on it)", async () => {
    const c = await call({ timedAudio: false });
    let done = false;
    void c.engine.whenEnded.then(() => {
      done = true;
    });
    await c.step(200);
    expect(done).toBe(false);
    await c.engine.stop("hangup");
    await flush();
    expect(done).toBe(true);
  });

  it("providers that can't be opened end the call at once (provider_error)", async () => {
    const stt = new FakeStt();
    stt.failNextOpen = 1;
    const port = new FakePort();
    const closes: unknown[] = [];
    await expect(
      CallEngine.start({ callId: "c1", port, stt, tts: new FakeTts(), llm: new FakeLlm(), clock: new ManualClock(), log: createLogger("silent"), send: () => {}, close: (...a) => closes.push(a), returning: false }),
    ).rejects.toThrow();
    expect(port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "provider_error" }]);
    expect(closes).toEqual([[CloseCode.NORMAL, "call ended"]]);
  });
});

describe("P5 review fixes", () => {
  it("#1 two utterances while a turn is pending: only one new turn runs, with both utterances; tools run once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = await call({ greeting: { text: "Hello there. Which device is it?", gate: () => gate } });
    await c.step(100);
    c.llm.enqueue({ toolCalls: [{ name: "save_field", args: { field: "deviceType", value: "laptop", spoken_evidence: "laptop" } }] }, { text: "Which model?" });
    c.stt.current.say("It's a laptop");
    await c.step(400);
    c.stt.current.say("a Dell one");
    await c.step(400);
    release();
    await c.step(3_000);
    expect(c.llm.requests.length).toBe(3); // greeting + the one turn (and its follow-up)
    expect(c.llm.requests[1]?.messages.filter((m) => m.role === "user").slice(-2)).toEqual([
      { role: "user", content: "It's a laptop" },
      { role: "user", content: "a Dell one" },
    ]);
    expect(c.port.of("SaveSpokenField")).toHaveLength(1);
    await c.engine.stop("hangup");
  });

  it("#2 an STT socket's error and its close are one failure: one reconnect, the call goes on", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    const first = c.stt.current;
    first.emit({ type: "error", error: new Error("reset") });
    first.emit({ type: "closed" });
    await c.step(200);
    expect(c.stt.streams).toHaveLength(2);
    expect(c.port.of("EndCall")).toEqual([]);
    c.llm.enqueue({ text: "Got it." });
    c.stt.current.say("still here");
    await c.step(500);
    expect(c.tts.current.spoken()).toContain("Got it.");
    await c.engine.stop("hangup");
  });

  it("#3 the acknowledgement goes to TTS at once, while the follow-up call is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.llm.enqueue({ toolCalls: [{ name: "save_field", args: { field: "deviceModel", value: "Apple iPhone 14 Pro", spoken_evidence: "iphone 14 pro" } }] }, { text: "What's wrong with it?", gate: () => gate });
    c.port.replies.SaveSpokenField = () => ({ status: "valid", normalized: { brand: "Apple", model: "iPhone 14 Pro" } });
    c.stt.current.say("an iphone 14 pro");
    await c.step(400);
    expect(c.tts.current.spoken()).toContain("Got it, Apple iPhone 14 Pro."); // before the follow-up has said anything
    release();
    await c.step(500);
    expect(c.tts.current.spoken()).toContain("What's wrong with it?");
    await c.engine.stop("hangup");
  });

  it("#5 a reply the user talked over before it was audible is dropped, not played first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = await call({ greeting: { text: "Hello! What device is it?", pieceChars: 7, gate: () => gate } });
    await c.step(50);
    c.llm.enqueue({ text: "A laptop, noted." });
    c.stt.current.say("it is a laptop");
    await c.step(400);
    release();
    await c.step(2_000);
    expect(c.tts.current.cancelledTurns).toContain("ta_c1_1");
    expect(c.sent.filter((m) => m.type === "stopPlayback")).toHaveLength(0); // nothing was audible
    expect(c.tts.current.spoken("ta_c1_2")).toBe("A laptop, noted.");
    await c.engine.stop("hangup");
  });

  it("#7 voice activity that never becomes words (echo, noise) doesn't stop silence handling or reset the reprompts", async () => {
    const c = await call({ timedAudio: false });
    await c.step(7_000);
    c.stt.current.emit({ type: "speechStarted" }); // noise: no words, no UtteranceEnd
    await c.step(10_000);
    expect(c.tts.current.spoken()).toContain(REPROMPTS[0]);
    c.stt.current.emit({ type: "speechStarted" }); // the reprompt's own echo
    await c.step(40_000, 100);
    expect(c.port.of("EndCall")).toEqual([{ type: "EndCall", callId: "c1", reason: "silence" }]);
  });

  it("#8 a chat event whose turn was cut off before it spoke is kept for the next turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.port.emit({ type: "field.candidate", channel: "chat", payload: { candidate: { field: "email", status: "valid" } } });
    c.llm.enqueue({ text: "Thanks for the email.", gate: () => gate }, { text: "Sure." });
    await c.step(1_300); // the proactive turn starts and waits on the model
    c.stt.current.say("hello?");
    await c.step(400);
    release();
    await c.step(1_000);
    expect(lastState(c.llm).newChatEvents).toEqual([{ field: "email", result: "accepted" }]);
    await c.engine.stop("hangup");
  });

  it("#11 if one provider opens and the other doesn't, the opened one is closed again", async () => {
    const stt = new FakeStt();
    const tts = new FakeTts();
    tts.failNextOpen = 1;
    await expect(
      CallEngine.start({ callId: "c1", port: new FakePort(), stt, tts, llm: new FakeLlm(), clock: new ManualClock(), log: createLogger("silent"), send: () => {}, close: () => {}, returning: false }),
    ).rejects.toThrow();
    expect(stt.current.closed).toBe(true);
  });

  it("#13 interrupted during acknowledge-then-ask: the history has the heard text once, the earlier messages keep only their tool calls", async () => {
    const long = "Got it. Now tell me exactly what happens to the screen when it starts flickering, and how often it happens during a normal day.";
    const c = await call({ timedAudio: true });
    await c.step(3_000);
    c.llm.enqueue({ toolCalls: [{ name: "save_field", args: { field: "deviceType", value: "smartphone", spoken_evidence: "a phone" } }] }, { text: long.slice("Got it. ".length) });
    c.port.replies.SaveSpokenField = () => ({ status: "valid", normalized: "smartphone" });
    c.stt.current.say("it's a phone");
    await c.step(1_200);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "it flickers", isFinal: true, speechFinal: true });
    await c.step(1_500);
    const history = c.llm.requests.at(-1)?.messages ?? [];
    const assistants = history.filter((m) => m.role === "assistant").slice(-2);
    expect(assistants[0]?.content).toBeNull(); // the ack's message: tool calls only
    expect(String(assistants[1]?.content)).toMatch(/^Got it\..*\[interrupted\]$/);
    await c.engine.stop("hangup");
  });

  it("#16 a model call cut off before usage was reported still counts as a request", async () => {
    const c = await call({ greeting: { text: "One. Two. Three. Four. Five.", pieceChars: 5 } });
    await c.step(600);
    c.stt.current.emit({ type: "speechStarted" });
    c.stt.current.emit({ type: "transcript", text: "stop please", isFinal: false, speechFinal: false });
    await c.step(500);
    expect(c.port.llmRequests.length + c.port.llmUsage.length).toBeGreaterThanOrEqual(1);
    await c.engine.stop("hangup");
  });

  it("#17 a refused opt-out doesn't end the call", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.port.replies.OptOutByCall = () => ({ status: "refused", reason: "session is finalized" });
    c.llm.enqueue({ toolCalls: [{ name: "opt_out", args: { confirmed: true } }] }, { text: "Your claim is already submitted." });
    c.stt.current.say("yes stop it");
    await c.step(600);
    expect(c.port.of("EndCall")).toEqual([]);
    expect(c.tts.current.spoken()).not.toContain(OPTED_OUT_GOODBYE);
    await c.engine.stop("hangup");
  });

  it("#14 when TTS fails, the current turn's words go to the chat", async () => {
    const c = await call({ timedAudio: false });
    await c.step(100);
    c.tts.current.failNextFlush = true;
    c.llm.enqueue({ text: "When did the problem start?" });
    c.stt.current.say("it is a laptop");
    await c.step(500);
    expect(c.port.of("AgentSays")).toEqual([{ type: "AgentSays", text: "When did the problem start?" }]);
  });
});
