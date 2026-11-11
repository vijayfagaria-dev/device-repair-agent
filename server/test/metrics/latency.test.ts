import { describe, expect, it } from "vitest";
import { buildTurnMetric, callIdOfTurn } from "../../src/metrics/latency.js";

describe("callIdOfTurn", () => {
  it("reads the call out of an agent turn id", () => {
    expect(callIdOfTurn("ta_c_1b2_7")).toBe("c_1b2");
    expect(callIdOfTurn("ta_c1_12")).toBe("c1");
  });
  it("refuses ids that are not agent turn ids", () => {
    for (const id of ["tu_c1_1", "ta_c1", "ta__1", "c1_1", "", "ta_c1_x"]) expect(callIdOfTurn(id)).toBeNull();
  });
});

describe("buildTurnMetric", () => {
  const base = { turnId: "ta_c1_2", callId: "c1" };
  it("computes server ms from the user end to the first audio, and keeps the stage timings", () => {
    const metric = buildTurnMetric({ ...base, userEndAt: 10_000, firstAudioAt: 11_234.6, sttMs: 300, llmTtftMs: 410.4, ttsTtfbMs: 180 });
    expect(metric).toEqual({
      ...base,
      userEndAt: new Date(10_000),
      firstAudioAt: new Date(11_234.6),
      serverMs: 1235,
      sttMs: 300,
      llmTtftMs: 410,
      ttsTtfbMs: 180,
    });
  });
  it("has no server ms without both ends, and no STT wait without a user utterance", () => {
    expect(buildTurnMetric({ ...base, userEndAt: 5, firstAudioAt: null, sttMs: 300 })).toEqual({ ...base, userEndAt: new Date(5), sttMs: 300 });
    expect(buildTurnMetric({ ...base, userEndAt: null, firstAudioAt: 9, sttMs: 300, ttsTtfbMs: 50 })).toEqual({ ...base, firstAudioAt: new Date(9), ttsTtfbMs: 50 });
  });
  it("never goes negative (clock steps) and records nothing for a turn with neither end", () => {
    expect(buildTurnMetric({ ...base, userEndAt: 100, firstAudioAt: 90 })?.serverMs).toBe(0);
    expect(buildTurnMetric({ ...base, userEndAt: null, firstAudioAt: null, llmTtftMs: 5 })).toBeNull();
  });
});
