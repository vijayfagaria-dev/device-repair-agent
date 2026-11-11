// The Aura-2 TTS adapter (P5-T04) against a local mock of the speak socket that behaves like the P5-T01 capture:
// 1,920-byte frames then `Flushed`; after `Clear`, more frames keep coming before `Cleared` (or none comes at all).
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { Secret } from "../../src/config.js";
import { createDeepgramTts } from "../../src/voice/deepgramTts.js";
import type { TtsEvent } from "../../src/voice/types.js";

interface MockOptions {
  /** Answer Clear this late (after the adapter has given up and reopened). */
  clearedAfterMs?: number;
  framesPerChunk?: number;
  /** Frames still sent after Clear (P0-T03 measured 1.1–2.2 s worth). */
  framesAfterClear?: number;
  /** Never answer Clear. */
  noCleared?: boolean;
  /** Drop the connection after this many frames of the first chunk. */
  dropAfterFrames?: number;
}

let server: WebSocketServer | null = null;
const connections: { url: string; auth?: string; received: string[] }[] = [];
afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  connections.length = 0;
});

async function mock(options: MockOptions = {}): Promise<string> {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let dropped = false;
  server.on("connection", (socket: WebSocket, request) => {
    const connection = { url: request.url ?? "", auth: request.headers.authorization, received: [] as string[] };
    connections.push(connection);
    let pending = "";
    let busyUntil = 0;
    let timers: NodeJS.Timeout[] = [];
    const frame = (byte: number) => Buffer.alloc(1920, byte);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string; text?: string };
      connection.received.push(message.type === "Speak" ? `Speak:${message.text}` : message.type);
      if (message.type === "Speak") pending += message.text ?? "";
      if (message.type === "Flush") {
        // Chunks are spoken one after another, like Aura-2: this one starts when the previous one is done.
        const text = pending;
        pending = "";
        const n = options.framesPerChunk ?? 3;
        const start = Math.max(Date.now(), busyUntil);
        busyUntil = start + 5 * (n + 1);
        const offset = start - Date.now();
        for (let i = 0; i < n; i++) {
          timers.push(
            setTimeout(() => {
              if (!dropped && options.dropAfterFrames !== undefined && i === options.dropAfterFrames) {
                dropped = true;
                socket.terminate();
                return;
              }
              if (socket.readyState === socket.OPEN) socket.send(frame(text.length % 256));
            }, offset + 5 * (i + 1)),
          );
        }
        timers.push(setTimeout(() => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: "Flushed" })), offset + 5 * (n + 1)));
      }
      if (message.type === "Clear") {
        for (const t of timers) clearTimeout(t);
        timers = [];
        busyUntil = 0;
        for (let i = 0; i < (options.framesAfterClear ?? 4); i++) setTimeout(() => socket.readyState === socket.OPEN && socket.send(frame(9)), 3 * (i + 1));
        if (!options.noCleared) setTimeout(() => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: "Cleared" })), options.clearedAfterMs ?? 3 * ((options.framesAfterClear ?? 4) + 2));
      }
      if (message.type === "Close") socket.close(1000);
    });
  });
  await new Promise((resolve) => server?.once("listening", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/speak`;
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function open(url: string, extra: { clearTimeoutMs?: number } = {}) {
  const events: TtsEvent[] = [];
  const stream = await createDeepgramTts({ apiKey: new Secret("fake-deepgram-key-for-tests"), url, voice: "aura-2-thalia-en", ...extra }).open((e) => events.push(e));
  return { stream, events, audio: (turnId?: string) => events.filter((e) => e.type === "audio" && (turnId === undefined || e.turnId === turnId)) };
}

describe("Aura-2 adapter", () => {
  it("asks for linear16 at 24 kHz with the voice and the key; forwards each chunk's audio in order, tagged with its turn, then flushed", async () => {
    const url = await mock();
    const { stream, events, audio } = await open(url);
    stream.speak("ta_c_1", "Hello there.");
    stream.flush("ta_c_1");
    stream.speak("ta_c_1", "Which model is it?");
    stream.flush("ta_c_1");
    await waitFor(() => events.filter((e) => e.type === "flushed").length === 2);
    expect(connections[0]?.auth).toBe("Token fake-deepgram-key-for-tests");
    expect(Object.fromEntries(new URLSearchParams(connections[0]?.url.split("?")[1]))).toEqual({ model: "aura-2-thalia-en", encoding: "linear16", sample_rate: "24000" });
    expect(connections[0]?.received).toEqual(["Speak:Hello there.", "Flush", "Speak:Which model is it?", "Flush"]);
    // 3 frames per chunk; one "flushed" per chunk, in order.
    expect(audio("ta_c_1")).toHaveLength(6);
    expect(audio().map((e) => e.type === "audio" && e.pcm[0])).toEqual([12, 12, 12, 18, 18, 18]);
    expect(events.filter((e) => e.type === "flushed")).toEqual([
      { type: "flushed", turnId: "ta_c_1" },
      { type: "flushed", turnId: "ta_c_1" },
    ]);
    expect(audio().every((e) => e.type === "audio" && e.sampleRate === 24000 && e.pcm.length === 1920)).toBe(true);
    await stream.close();
  });

  it("after cancel(), not one more frame of that turn is emitted, although the provider keeps sending after Clear", async () => {
    const url = await mock({ framesPerChunk: 20, framesAfterClear: 6 });
    const { stream, events, audio } = await open(url);
    stream.speak("ta_c_1", "This is a long sentence that will be interrupted.");
    stream.flush("ta_c_1");
    await waitFor(() => audio().length >= 2);
    stream.cancel("ta_c_1");
    const atCancel = audio().length;
    // The next turn waits for Cleared, then plays.
    stream.speak("ta_c_2", "Sure, go ahead.");
    stream.flush("ta_c_2");
    await waitFor(() => events.some((e) => e.type === "flushed" && e.turnId === "ta_c_2"));
    expect(audio("ta_c_1")).toHaveLength(atCancel); // 0 frames after cancel
    expect(audio("ta_c_2").length).toBeGreaterThan(0);
    expect(audio("ta_c_2").every((e) => e.type === "audio" && e.pcm[0] !== 9)).toBe(true); // none of the post-Clear frames
    expect(connections[0]?.received).toEqual(["Speak:This is a long sentence that will be interrupted.", "Flush", "Clear", "Speak:Sure, go ahead.", "Flush"]);
    await stream.close();
  });

  it("if Cleared doesn't come within the timeout, a fresh socket is opened and the next turn plays on it", async () => {
    const url = await mock({ framesPerChunk: 20, framesAfterClear: 3, noCleared: true });
    const { stream, events, audio } = await open(url, { clearTimeoutMs: 100 });
    stream.speak("ta_c_1", "Interrupt me.");
    stream.flush("ta_c_1");
    await waitFor(() => audio().length >= 1);
    stream.cancel("ta_c_1");
    stream.speak("ta_c_2", "Next.");
    stream.flush("ta_c_2");
    await waitFor(() => events.some((e) => e.type === "flushed" && e.turnId === "ta_c_2"));
    expect(connections).toHaveLength(2);
    expect(connections[1]?.received).toEqual(["Speak:Next.", "Flush"]);
    await stream.close();
  });

  it("a socket dropped mid-chunk is reopened once and the unfinished chunk is sent again", async () => {
    const url = await mock({ framesPerChunk: 5, dropAfterFrames: 2 });
    const { stream, events, audio } = await open(url);
    stream.speak("ta_c_1", "Please say that again.");
    stream.flush("ta_c_1");
    await waitFor(() => events.some((e) => e.type === "flushed"));
    expect(connections).toHaveLength(2);
    expect(connections[1]?.received).toEqual(["Speak:Please say that again.", "Flush"]);
    expect(audio("ta_c_1").length).toBeGreaterThanOrEqual(5);
    expect(events.some((e) => e.type === "error")).toBe(false);
    await stream.close();
  });

  it("ignores text for a cancelled turn, and close() sends Close", async () => {
    const url = await mock();
    const { stream, events } = await open(url);
    stream.cancel("ta_c_9");
    stream.speak("ta_c_9", "Nothing.");
    stream.flush("ta_c_9");
    await stream.close();
    expect(connections[0]?.received).toEqual(["Close"]);
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("#6 a Cleared that comes after the adapter reopened doesn't send the waiting speech to the old socket", async () => {
    const url = await mock({ framesPerChunk: 20, framesAfterClear: 3, clearedAfterMs: 150 });
    const { stream, events, audio } = await open(url, { clearTimeoutMs: 100 });
    stream.speak("ta_c_1", "Interrupt me.");
    stream.flush("ta_c_1");
    await waitFor(() => audio().length >= 1);
    stream.cancel("ta_c_1");
    stream.speak("ta_c_2", "Next.");
    stream.flush("ta_c_2");
    await waitFor(() => events.some((e) => e.type === "flushed" && e.turnId === "ta_c_2"));
    expect(connections).toHaveLength(2);
    expect(connections[0]?.received.filter((r) => r.startsWith("Speak"))).toEqual(["Speak:Interrupt me."]);
    expect(connections[1]?.received).toEqual(["Speak:Next.", "Flush"]);
    expect(audio("ta_c_2").every((e) => e.type === "audio" && e.pcm[0] !== 9)).toBe(true);
    await stream.close();
  });
});
