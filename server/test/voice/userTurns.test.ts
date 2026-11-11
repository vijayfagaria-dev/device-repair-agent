// The end-of-utterance event time (P11-T02): the latency clock starts at STT's event, not after the merge window.
import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/voice/clock.js";
import { type Utterance, UserTurns } from "../../src/voice/userTurns.js";

function setup() {
  const clock = new ManualClock();
  const ended: Utterance[] = [];
  const turns = new UserTurns({ callId: "c1", clock, onLine: () => {}, onTurnEnd: (u) => ended.push(u) });
  const say = (text: string, speechFinal = true) => turns.handle({ type: "transcript", text, isFinal: true, speechFinal });
  return { clock, ended, turns, say };
}

describe("UserTurns end event time", () => {
  it("is the speech_final time; the merge window is the gap to endedAt", () => {
    const { clock, ended, say } = setup();
    say("my phone is broken");
    const eventAt = clock.now();
    clock.advance(300);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ endEventAt: eventAt, endedAt: eventAt + 300 });
  });

  it("is the last speech_final when words join within the merge window", () => {
    const { clock, ended, say } = setup();
    say("my phone is broken");
    clock.advance(200);
    say("it fell in water");
    const second = clock.now();
    clock.advance(300);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ text: "my phone is broken it fell in water", endEventAt: second, endedAt: second + 300 });
  });

  it("is the UtteranceEnd time when no speech_final came, with no wait", () => {
    const { clock, ended, say, turns } = setup();
    say("hello there", false);
    clock.advance(1_000);
    turns.handle({ type: "utteranceEnd" });
    expect(ended[0]?.endEventAt).toBe(ended[0]?.endedAt);
    expect(ended[0]?.endedAt).toBe(clock.now());
  });

  it("does not carry over to the next utterance", () => {
    const { clock, ended, say } = setup();
    say("first one");
    clock.advance(300);
    clock.advance(5_000);
    say("second one");
    const at = clock.now();
    clock.advance(300);
    expect(ended.map((u) => u.endEventAt)).toEqual([ended[0]?.endEventAt, at]);
    expect(ended[1]?.endEventAt).toBeGreaterThan(ended[0]?.endEventAt ?? 0);
  });
});
