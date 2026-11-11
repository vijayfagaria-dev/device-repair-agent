// Speech output (P5-T11): the sentence chunker, and one agent turn through the fake TTS: the transcript line grows
// with what is sent and ends equal to it, audio goes out tagged and timed, and cancel() stops at once (P5-T07).
import { CallServerMessageType } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import { LONG_CHUNK_CHARS, SentenceChunker } from "../../src/agent/sentenceChunker.js";
import { ManualClock } from "../../src/voice/clock.js";
import { FAKE_FRAME_MS, FakeTts } from "../../src/voice/fakes/tts.js";
import { type CallMessage, heardText, INTERRUPTED_MARK, SpeechTurn } from "../../src/voice/speechOut.js";

const chunks = (...deltas: string[]) => {
  const chunker = new SentenceChunker();
  return [...deltas.flatMap((d) => chunker.push(d)), ...chunker.flush()];
};

describe("SentenceChunker", () => {
  it("cuts at . ? ! followed by a space, across streamed pieces", () => {
    expect(chunks("Got it", ", a Sam", "sung. When did it ", "start? Thanks", "!")).toEqual(["Got it, a Samsung.", "When did it start?", "Thanks!"]);
  });

  it("doesn't cut after abbreviations, initials or inside numbers", () => {
    expect(chunks("Dr. Rao said e.g. the 1.5 GHz model works. Okay.")).toEqual(["Dr. Rao said e.g. the 1.5 GHz model works.", "Okay."]);
    expect(chunks("Thanks, A. Rao. Next.")).toEqual(["Thanks, A. Rao.", "Next."]);
  });

  it("cuts a long sentence at a comma so speech starts early", () => {
    const long = `${"word ".repeat(22)}more words, and then the rest of a very long sentence without a stop`;
    const [first, ...rest] = chunks(long);
    expect(long.length).toBeGreaterThan(LONG_CHUNK_CHARS);
    expect(first?.endsWith(",")).toBe(true);
    expect(rest.join(" ")).toContain("and then the rest");
  });
});

/** Advances the manual clock in small steps, letting async work (the fake's chunk queue) run between them. */
async function step(clock: ManualClock, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 20) {
    clock.advance(Math.min(20, ms - t));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("SpeechTurn", () => {
  it("the agent line grows with each chunk sent and its final text is what was spoken; first audio is recorded", async () => {
    const clock = new ManualClock();
    const tts = new FakeTts({ clock });
    const sent: CallMessage[] = [];
    let speech: SpeechTurn | undefined;
    await tts.open((e) => speech?.onTts(e));
    const stream = tts.current;
    speech = new SpeechTurn("ta_c1_1", stream, clock, (m) => sent.push(m));
    const firstSpeakAt = clock.now();
    speech.say("Got it, a Samsung. ");
    speech.say("When did it start?");
    speech.end();
    await step(clock, 5_000);
    const spoken = await speech.done;
    const lines = sent.filter((m) => m.type === CallServerMessageType.TRANSCRIPT);
    expect(lines.map((l) => [l.type === "transcript" && l.text, l.type === "transcript" && l.final])).toEqual([
      ["Got it, a Samsung.", false],
      ["Got it, a Samsung. When did it start?", false],
      ["Got it, a Samsung. When did it start?", true],
    ]);
    expect(stream.spoken()).toBe("Got it, a Samsung. When did it start?");
    expect(spoken).toMatchObject({ id: "ta_c1_1", text: "Got it, a Samsung. When did it start?", interrupted: false, characters: 36 });
    expect(spoken.firstAudioAt).not.toBeNull();
    // Time to first byte runs from the first text sent to TTS to the first audio back (P11-T02).
    expect(spoken.ttsTtfbMs).toBe((spoken.firstAudioAt as number) - firstSpeakAt);
    expect(spoken.ttsTtfbMs).toBeGreaterThanOrEqual(0);
    expect(sent.filter((m) => m.type === CallServerMessageType.AUDIO).every((m) => m.type === "audio" && m.sampleRate === 24000)).toBe(true);
  });

  it("cancel(): no audio after it, the line is cut at what was heard and marked [interrupted]", async () => {
    const clock = new ManualClock();
    const tts = new FakeTts({ clock, charsPerFrame: 2 });
    const sent: CallMessage[] = [];
    let speech: SpeechTurn | undefined;
    await tts.open((e) => speech?.onTts(e));
    const stream = tts.current;
    speech = new SpeechTurn("ta_c1_1", stream, clock, (m) => sent.push(m));
    speech.say("The first sentence is short. The second one is much longer and keeps going for a while.");
    speech.end();
    await step(clock, FAKE_FRAME_MS * 20); // about 0.8 s of audio played
    const audioBefore = sent.filter((m) => m.type === "audio").length;
    const result = speech.cancel();
    await step(clock, 3_000);
    expect(sent.filter((m) => m.type === "audio").length).toBe(audioBefore); // 0 frames after cancel
    expect(stream.cancelledTurns).toEqual(["ta_c1_1"]);
    expect(result.interrupted).toBe(true);
    expect(result.heard.length).toBeGreaterThan(0);
    expect("The first sentence is short. The second one is much longer and keeps going for a while.".startsWith(result.heard)).toBe(true);
    expect(result.heard.length).toBeLessThan(60);
    const last = sent.at(-1);
    expect(last).toMatchObject({ type: "transcript", final: true, text: `${result.heard}${INTERRUPTED_MARK}` });
    expect(await speech.done).toBe(result);
  });

  it("heardText: whole chunks while their audio played, then a cut at a word boundary", () => {
    const c = [
      { text: "Got it.", audioMs: 500 },
      { text: "When did the problem start?", audioMs: 1000 },
    ];
    expect(heardText(c, 0)).toBe("");
    expect(heardText(c, 500)).toBe("Got it.");
    expect(heardText(c, 1000)).toBe("Got it. When did the");
    expect(heardText(c, 5000)).toBe("Got it. When did the problem start?");
  });

  it("heardText: a chunk still arriving is as long as its text at the finished chunks' rate (not fully heard)", () => {
    const c = [
      { text: "Got it.", audioMs: 700, complete: true }, // 100 ms per character
      { text: "When did the problem start?", audioMs: 300, complete: false }, // 27 chars → about 2.7 s
    ];
    expect(heardText(c, 1_000)).toBe("Got it.");
    expect(heardText(c, 2_000)).toBe("Got it. When did the");
  });
});

describe("P5 review fixes (speech output)", () => {
  it("#9 playback follows a cursor: a gap in the audio doesn't count as played; breakChunk speaks the held text", async () => {
    const clock = new ManualClock();
    const tts = new FakeTts();
    const sent: CallMessage[] = [];
    let speech: SpeechTurn | undefined;
    await tts.open((e) => speech?.onTts(e));
    speech = new SpeechTurn("ta_c1_1", tts.current, clock, (m) => sent.push(m));
    speech.say("Got it, Apple iPhone 14 Pro.");
    expect(tts.current.chunks).toEqual([]); // held: no space after the stop yet
    speech.breakChunk();
    expect(tts.current.chunks.map((c) => c.text)).toEqual(["Got it, Apple iPhone 14 Pro."]);
    const end1 = speech.playbackEndsAt();
    await step(clock, 3_000); // a 3 s gap (the follow-up call), the first chunk long played
    speech.say("What's wrong with it?");
    speech.end();
    // The new chunk plays from its arrival (now), not from the first frame: the old estimate (first frame + all audio
    // sent = end1 + 240 ms) would already lie in the past and report "not speaking".
    expect(speech.playbackEndsAt()).toBe(clock.now() + 240);
    expect(end1 + 240).toBeLessThan(clock.now());
    expect(speech.speaking).toBe(true);
  });
});
