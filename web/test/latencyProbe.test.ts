// P11-T02: the client latency probe on a fake clock. Speech end = the start of ≥ 300 ms of quiet after speech;
// the sample is taken at the first agent audio scheduled after it, once per utterance, joined by the turn id.
import { ChatClientMessageType, type ClientMetric } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import { LatencyProbe, MARK_TTL_MS, MIN_SPEECH_MS, QUIET_MS, SPEECH_LEVEL } from "../src/audio/latencyProbe";

const LOUD = SPEECH_LEVEL * 5;
const FRAME_MS = 20;

function setup() {
  const sent: ClientMetric[] = [];
  const probe = new LatencyProbe((m) => sent.push(m));
  let now = 1_000;
  /** Mic frames of one level for `ms`. */
  const mic = (level: number, ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      probe.onMicLevel(level, now);
      now += FRAME_MS;
    }
  };
  return { probe, sent, mic, clock: () => now, advance: (ms: number) => (now += ms) };
}

describe("LatencyProbe", () => {
  it("samples from the end of speech to the first agent audio scheduled to play, joined by the agent line's id", () => {
    const { probe, sent, mic, clock } = setup();
    mic(LOUD, 1_000);
    const speechEnd = clock(); // the first quiet frame
    mic(0, 1_200);
    probe.onAgentLine("ta_c1_2");
    probe.onAgentAudio(speechEnd + 1_380);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: ChatClientMessageType.CLIENT_METRIC, name: "turnLatency", turnId: "ta_c1_2", ms: 1_380 });
    expect(Number.isNaN(Date.parse(sent[0]?.at ?? ""))).toBe(false);
  });

  it("takes one sample per utterance: later audio of the same reply adds nothing", () => {
    const { probe, sent, mic, clock } = setup();
    mic(LOUD, 600);
    const end = clock();
    mic(0, 800);
    probe.onAgentLine("ta_c1_2");
    probe.onAgentAudio(end + 900);
    probe.onAgentAudio(end + 940);
    probe.onAgentAudio(end + 980);
    expect(sent).toHaveLength(1);
  });

  it("needs the quiet to last QUIET_MS: speech that resumes sooner is one utterance, and audio before the mark is no sample", () => {
    const { probe, sent, mic, clock } = setup();
    mic(LOUD, 500);
    mic(0, QUIET_MS - FRAME_MS * 2); // a pause inside a sentence
    mic(LOUD, 500);
    probe.onAgentLine("ta_c1_2");
    probe.onAgentAudio(clock() + 100);
    expect(sent).toEqual([]);
    mic(0, 400);
    probe.onAgentAudio(clock() + 100);
    expect(sent).toHaveLength(1);
  });

  it("measures from the final end when the user pauses and goes on", () => {
    const { probe, sent, mic, clock } = setup();
    mic(LOUD, 500);
    mic(0, 100);
    mic(LOUD, 500);
    const end = clock();
    mic(0, 600);
    probe.onAgentLine("ta_c1_2");
    probe.onAgentAudio(end + 1_000);
    expect(sent[0]?.ms).toBe(1_000);
  });

  it("ignores audio when the user hasn't just spoken (greeting, a proactive turn) and bursts shorter than MIN_SPEECH_MS", () => {
    const { probe, sent, mic, clock } = setup();
    probe.onAgentLine("ta_c1_1");
    probe.onAgentAudio(clock() + 50); // the greeting
    mic(LOUD, MIN_SPEECH_MS - FRAME_MS * 2); // a click
    mic(0, 600);
    probe.onAgentAudio(clock() + 50);
    expect(sent).toEqual([]);
  });

  it("drops a speech end that went stale (the agent answered much later, not to it) and audio with no turn id", () => {
    const stale = setup();
    stale.mic(LOUD, 500);
    const end = stale.clock();
    stale.mic(0, 600);
    stale.probe.onAgentLine("ta_c1_5");
    stale.probe.onAgentAudio(end + MARK_TTL_MS + 1);
    expect(stale.sent).toEqual([]);

    const noTurn = setup();
    noTurn.mic(LOUD, 500);
    noTurn.mic(0, 600);
    noTurn.probe.onAgentAudio(noTurn.clock() + 100);
    expect(noTurn.sent).toEqual([]);
  });

  it("the user talking again voids the earlier end, and reset() forgets everything", () => {
    const { probe, sent, mic, clock } = setup();
    mic(LOUD, 500);
    mic(0, 600);
    mic(LOUD, 300); // talks again before the agent answers
    probe.onAgentLine("ta_c1_2");
    probe.onAgentAudio(clock() + 100);
    expect(sent).toEqual([]);

    mic(0, 600);
    probe.reset();
    probe.onAgentLine("ta_c1_3");
    probe.onAgentAudio(clock() + 100);
    expect(sent).toEqual([]);
  });
});
