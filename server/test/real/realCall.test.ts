// A REAL call against the real providers (Deepgram STT + Aura-2, Groq), run only on demand:
//
//   REAL_PROVIDERS=1 npx vitest run server/test/real
//
// It reads the keys from server/.env (never printed), runs the app on the throwaway test Postgres, and uses a few
// seconds of free-tier quota. Skipped in normal runs (and CI): the fakes cover the logic; this proves the adapters
// work against the live services. The audio is synthetic speech from the P0-T03 spike (fixtures/audio/u1.wav).
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlmRouter, llmHops } from "../../src/agent/llm.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listTurnMetrics } from "../../src/db/repos/turnMetrics.js";
import { listUsage } from "../../src/db/repos/usage.js";
import type { SessionServices } from "../../src/session/services.js";
import { createDeepgramStt } from "../../src/voice/deepgram.js";
import { createDeepgramTts } from "../../src/voice/deepgramTts.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { testServices } from "../helpers/session.js";

const ENV_FILE = new URL("../../.env", import.meta.url);
const enabled = process.env.REAL_PROVIDERS === "1" && existsSync(ENV_FILE);
const env = enabled
  ? Object.fromEntries(
      readFileSync(ENV_FILE, "utf8")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
    )
  : {};

const wav = readFileSync(new URL("../fixtures/audio/u1.wav", import.meta.url));
const pcm = wav.subarray(wav.indexOf("data") + 8);
type Msg = { type: string; role?: string; final?: boolean; text?: string; id?: string };

describe.runIf(enabled)("a real call (REAL_PROVIDERS=1)", () => {
  let schema: TestSchema;
  let db: Database;
  let services: SessionServices;
  let server: RunningApp;

  beforeAll(async () => {
    ({ schema, db } = await createMigratedSchema("realcall", { max: 10 }));
    services = testServices(db, { planner: true });
    const deepgram = new Secret(env.DEEPGRAM_API_KEY ?? "");
    const llm = createLlmRouter({
      hops: llmHops({ groqApiKey: new Secret(env.GROQ_API_KEY ?? ""), geminiApiKey: env.GEMINI_API_KEY ? new Secret(env.GEMINI_API_KEY) : null, models: ["groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b", "gemini:gemini-flash-lite-latest"] }),
    });
    server = await startApp(db, {
      services,
      voice: { providers: () => ({ stt: createDeepgramStt({ apiKey: deepgram }), tts: createDeepgramTts({ apiKey: deepgram }), llm }), maxConcurrentCalls: 2, timings: { silenceMs: 60_000 } },
    });
  });
  afterAll(async () => {
    await server?.close();
    await schema?.drop();
  });

  const waitFor = async (check: () => boolean, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const stream = async (socket: TestSocket, bytes: Buffer, silenceMs = 1_500) => {
    const frames: Buffer[] = [];
    for (let i = 0; i + 640 <= bytes.length; i += 640) frames.push(bytes.subarray(i, i + 640));
    for (let i = 0; i < silenceMs / 20; i++) frames.push(Buffer.alloc(640));
    for (const frame of frames) {
      socket.ws.send(frame);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const all = (socket: TestSocket) => socket.messages as Msg[];

  it("greets, hears the user (Deepgram), answers (Groq → Aura-2), and records usage, metrics and the transcript", async () => {
    const id = randomUUID();
    const socket = connect(`${server.ws}/call?sessionId=${id}`);
    await socket.opened;
    const started = Date.now();
    await waitFor(() => all(socket).some((m) => m.type === "audio"), "the greeting's first audio");
    const greetingMs = Date.now() - started;
    await waitFor(() => all(socket).some((m) => m.type === "transcript" && m.role === "agent" && m.final), "the greeting line");
    const greeting = all(socket).find((m) => m.type === "transcript" && m.role === "agent" && m.final);

    const audioBefore = all(socket).filter((m) => m.type === "audio").length;
    await new Promise((resolve) => setTimeout(resolve, 4_000)); // let the greeting finish playing (no barge-in here)
    const sendStart = Date.now();
    await stream(socket, pcm);
    const userEnd = sendStart + Math.round((pcm.length / 32_000) * 1000);
    await waitFor(() => all(socket).some((m) => m.type === "transcript" && m.role === "user" && m.final), "the user's final line");
    const user = all(socket).find((m) => m.type === "transcript" && m.role === "user" && m.final);
    await waitFor(() => all(socket).filter((m) => m.type === "transcript" && m.role === "agent" && m.final).length >= 2, "the agent's answer");
    const answer = all(socket).filter((m) => m.type === "transcript" && m.role === "agent" && m.final).at(-1);
    const firstAnswerAudio = all(socket).findIndex((m, i) => i > all(socket).indexOf(user as Msg) && m.type === "audio");

    socket.ws.close(1000);
    await socket.closed;
    await waitFor(() => true, "");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const events = await listEvents(db.pool, id);
    const usage = await listUsage(db.pool, id);
    const metrics = await listTurnMetrics(db.pool, id);
    console.log(
      JSON.stringify(
        {
          greetingFirstAudioMs: greetingMs,
          greeting: greeting?.text,
          user: user?.text,
          answer: answer?.text,
          userAudioEndToNow: Date.now() - userEnd,
          serverMs: metrics.map((m) => m.serverMs),
          llmTtftMs: metrics.map((m) => m.llmTtftMs),
          usage: usage.map((u) => `${u.provider}:${u.kind}=${u.units}`),
          tools: events.filter((e) => e.type === "field.candidate").map((e) => (e.payload.candidate as { field: string; status: string }).field),
        },
        null,
        1,
      ),
    );
    expect(audioBefore).toBeGreaterThan(0);
    expect(user?.text?.toLowerCase()).toContain("flicker");
    expect(firstAnswerAudio).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "call.ended").map((e) => e.payload.reason)).toEqual(["hangup"]);
    expect(events.filter((e) => e.type === "transcript.final").length).toBeGreaterThanOrEqual(3);
    expect(usage.some((u) => u.kind === "nova-3:audio")).toBe(true);
    expect(usage.some((u) => u.kind === "aura-2:characters")).toBe(true);
    expect(usage.some((u) => u.provider === "groq")).toBe(true);
    expect(metrics.some((m) => typeof m.serverMs === "number")).toBe(true);
  }, 90_000);

  it("barge-in: the user talking over the greeting gets stopPlayback, and the greeting line is marked [interrupted]", async () => {
    const id = randomUUID();
    const socket = connect(`${server.ws}/call?sessionId=${id}`);
    await socket.opened;
    await waitFor(() => all(socket).some((m) => m.type === "audio"), "the greeting's first audio");
    await new Promise((resolve) => setTimeout(resolve, 400)); // past the 250 ms window, mid-greeting
    const talkStarted = Date.now();
    void stream(socket, pcm);
    await waitFor(() => all(socket).some((m) => m.type === "stopPlayback"), "stopPlayback", 10_000);
    const stopMs = Date.now() - talkStarted;
    await waitFor(() => all(socket).some((m) => m.type === "transcript" && m.role === "agent" && m.final && String(m.text).endsWith("[interrupted]")), "the interrupted line");
    console.log(JSON.stringify({ stopPlaybackMsAfterSpeechStart: stopMs }));
    socket.ws.close(1000);
    await socket.closed;
  }, 60_000);
});
