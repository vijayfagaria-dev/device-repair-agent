// The Deepgram STT adapter and the user-turn tracker (P5-T03), driven by REAL Deepgram events captured in P5-T01
// (fixtures/providers/deepgram-stt-u1.json) and by a local mock of the listen socket. No network.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Secret } from "../../src/config.js";
import { ManualClock } from "../../src/voice/clock.js";
import { createDeepgramStt, toSttEvent } from "../../src/voice/deepgram.js";
import type { SttEvent } from "../../src/voice/types.js";
import { type UserLine, UserTurns, type Utterance } from "../../src/voice/userTurns.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/providers/deepgram-stt-u1.json", import.meta.url), "utf8")) as {
  params: string;
  audioBytes: number;
  events: { atMs: number; message: Record<string, unknown> }[];
};

function track(mergeMs = 300) {
  const clock = new ManualClock();
  const lines: UserLine[] = [];
  const turns: Utterance[] = [];
  const turnsTracker = new UserTurns({ callId: "c1", clock, mergeMs, onLine: (l) => lines.push(l), onTurnEnd: (u) => turns.push(u) });
  return { clock, lines, turns, tracker: turnsTracker };
}

describe("real Deepgram events (P5-T01 capture) → transcript lines and the end of the turn", () => {
  it("maps every message type the capture contains; Metadata is ignored", () => {
    const events = fixture.events.map((e) => toSttEvent(e.message));
    expect(events.filter(Boolean).map((e) => (e as SttEvent).type)).toEqual(["speechStarted", "transcript", "transcript", "transcript", "transcript", "transcript", "transcript", "utteranceEnd", "transcript", "transcript"]);
    expect(events.at(-1)).toBeNull(); // Metadata
  });

  it("one id for the whole utterance: interims grow in place, the final replaces them, the turn ends once", () => {
    const { clock, lines, turns, tracker } = track();
    for (const { message } of fixture.events) {
      const event = toSttEvent(message);
      if (event) tracker.handle(event);
    }
    clock.advance(300); // the merge window (UtteranceEnd already ended it)
    expect(new Set(lines.map((l) => l.id))).toEqual(new Set(["tu_c1_1"]));
    expect(lines.filter((l) => !l.final).map((l) => l.text)).toEqual([
      "Hi. My phone",
      "Hi. My phone screen keeps",
      "Hi. My phone screen keeps flickering and then it",
      "Hi. My phone screen keeps flickering and then it goes completely",
      "Hi. My phone screen keeps flickering and then it goes completely black.",
    ]);
    const finals = lines.filter((l) => l.final);
    expect(finals).toEqual([{ id: "tu_c1_1", text: "Hi. My phone screen keeps flickering and then it goes completely black.", final: true }]);
    expect(turns.map((t) => t.text)).toEqual(["Hi. My phone screen keeps flickering and then it goes completely black."]);
  });

  it("speech after speech_final but within the merge window joins the same turn; after it, a new utterance", () => {
    const { clock, lines, turns, tracker } = track(300);
    tracker.handle({ type: "transcript", text: "It's a Samsung", isFinal: true, speechFinal: true });
    clock.advance(200);
    tracker.handle({ type: "transcript", text: "Galaxy S23.", isFinal: true, speechFinal: true });
    clock.advance(300);
    expect(turns.map((t) => [t.id, t.text])).toEqual([["tu_c1_1", "It's a Samsung Galaxy S23."]]);
    tracker.handle({ type: "transcript", text: "Yes.", isFinal: true, speechFinal: true });
    clock.advance(300);
    expect(turns.map((t) => t.id)).toEqual(["tu_c1_1", "tu_c1_2"]);
    expect(lines.filter((l) => l.final).length).toBe(2);
  });

  it("voice activity that never became words ends quietly (no line, no turn)", () => {
    const { lines, turns, tracker } = track();
    tracker.handle({ type: "speechStarted" });
    expect(tracker.speaking).toBe(true);
    tracker.handle({ type: "utteranceEnd" });
    expect(lines).toEqual([]);
    expect(turns).toEqual([]);
    expect(tracker.speaking).toBe(false);
  });
});

describe("createDeepgramStt against a local mock of the listen socket", () => {
  let server: WebSocketServer | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function mock(onConnect: (socket: import("ws").WebSocket, request: import("node:http").IncomingMessage) => void): Promise<string> {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("connection", onConnect);
    await new Promise((resolve) => server?.once("listening", resolve));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`;
  }

  it("sends the measured options and the key as a Token header, forwards audio, maps replies, and closes with CloseStream", async () => {
    let seen: { url: string; auth: string | undefined; bytes: number; control: string[] } = { url: "", auth: undefined, bytes: 0, control: [] };
    const url = await mock((socket, request) => {
      seen = { url: request.url ?? "", auth: request.headers.authorization, bytes: 0, control: [] };
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          seen.bytes += (data as Buffer).length;
          if (seen.bytes === 640 * 3) for (const { message } of fixture.events) socket.send(JSON.stringify(message));
          return;
        }
        const message = JSON.parse(String(data));
        seen.control.push(message.type);
        if (message.type === "CloseStream") socket.close(1000);
      });
    });
    const events: SttEvent[] = [];
    const stt = await createDeepgramStt({ apiKey: new Secret("fake-deepgram-key-for-tests"), url }).open((e) => events.push(e));
    for (let i = 0; i < 3; i++) stt.push(Buffer.alloc(640));
    await new Promise<void>((resolve) => {
      const check = () => (events.some((e) => e.type === "utteranceEnd") ? resolve() : setTimeout(check, 5));
      check();
    });
    await stt.close();
    expect(seen.auth).toBe("Token fake-deepgram-key-for-tests");
    const params = new URLSearchParams(seen.url.split("?")[1]);
    expect(Object.fromEntries(params)).toMatchObject({ model: "nova-3-general", encoding: "linear16", sample_rate: "16000", interim_results: "true", endpointing: "150", utterance_end_ms: "1000", vad_events: "true" });
    expect(seen.bytes).toBe(1920);
    expect(seen.control).toContain("CloseStream");
    expect(events.filter((e) => e.type === "transcript" && e.speechFinal && e.text).length).toBe(1);
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("sends KeepAlive when no audio has gone out for a while; rejects when the socket can't open", async () => {
    const control: string[] = [];
    const url = await mock((socket) => socket.on("message", (data, isBinary) => !isBinary && control.push(JSON.parse(String(data)).type)));
    const stt = await createDeepgramStt({ apiKey: new Secret("k".repeat(24)), url, keepAliveMs: 10 }).open(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(control).toContain("KeepAlive");
    await stt.close();
    await expect(createDeepgramStt({ apiKey: new Secret("k".repeat(24)), url: "ws://127.0.0.1:1/v1/listen", connectTimeoutMs: 500 }).open(() => {})).rejects.toThrow();
  });
});

describe("the fake STT (P5-T01) replays the recorded fixture like the real adapter", () => {
  it("same events, same utterance", async () => {
    const { FakeStt } = await import("../../src/voice/fakes/stt.js");
    const fake = new FakeStt();
    const { clock, turns, tracker } = track();
    const stream = await fake.open((event) => tracker.handle(event));
    (stream as InstanceType<typeof FakeStt>["streams"][number]).replay(fixture.events.map((e) => e.message));
    clock.advance(300);
    expect(turns.map((t) => t.text)).toEqual(["Hi. My phone screen keeps flickering and then it goes completely black."]);
  });
});
