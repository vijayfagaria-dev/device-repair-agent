// Live-call regressions (sessions 51ba, 5db2, 5efb, 2026-11-11): markup, invisible characters and filler loops in speech.
import { describe, expect, it } from "vitest";
import { SpeechFilter, cleanSpeech } from "../../src/agent/speechFilter.js";

describe("SpeechFilter", () => {
  it("drops prompt markup, even when split across deltas", () => {
    const f = new SpeechFilter();
    const out = ["Got it, <customer_wo", 'rds field="deviceModel">', ". Next?"].map((d) => f.push(d)).join("");
    expect(out).toBe("Got it, . Next?");
  });
  it("keeps a stray < that never closes", () => {
    expect(cleanSpeech(`a < b ${"x".repeat(200)}`)).toContain("a");
  });
  it("separates glued sentences", () => {
    expect(cleanSpeech("When did it start?How urgent is it?")).toBe("When did it start? How urgent is it?");
    const f = new SpeechFilter();
    expect(f.push("in the chat.") + f.push("When you are ready") + f.flush()).toBe("in the chat. When you are ready");
  });
  it("does not split abbreviations or numbers", () => {
    expect(cleanSpeech("In the U.S.A. it is 3.5 inches")).toBe("In the U.S.A. it is 3.5 inches");
  });
  it("removes zero-width characters", () => {
    expect(cleanSpeech("Hel​​lo")).toBe("Hello");
  });
  it("flags runaway filler as degenerate and collapses it", () => {
    const f = new SpeechFilter();
    const out = f.push(`Check ${"… \n\n ... … ".repeat(10)}`);
    expect(f.degenerate).toBe(true);
    expect(out.length).toBeLessThan(40);
  });
  it("does not flag normal speech", () => {
    const f = new SpeechFilter();
    f.push("Okay... let me check that for you. One moment.");
    expect(f.degenerate).toBe(false);
  });
});

describe("internal names", () => {
  it("never speaks field ids or state keys (user report, 2026-11-11)", () => {
    expect(cleanSpeech("I have saved your deviceModel and the problemStartedAt, readyToSubmit is true.")).toBe("I have saved your device model and the start date, is true.");
  });
  it("catches a name split across streamed pieces, and flushes the last word", () => {
    const f = new SpeechFilter();
    const out = ["Your device", "Model is set. Now the ser", "ialNumber"].map((d) => f.push(d)).join("") + f.flush();
    expect(out).toBe("Your device model is set. Now the serial number");
  });
});
