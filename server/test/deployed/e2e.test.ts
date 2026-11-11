// P10-T05's script, checked against a LOCAL deployment-like server (the real app, real chat/call sockets, the real
// outbox worker delivering to the real stub receiver, the built web UI) with providers that are fakes. This proves the
// script's own logic: its assertions can pass, and fail when the system misbehaves, including across a restart. It does
// NOT prove the deployment works or that Deepgram/Groq work: only a run against the public URL with the real providers
// (`node test/deployed/e2e.ts <url>`) does that. The STT here "hears" the WAV's loudness (speech start, interim words, an
// end after 500 ms of quiet); the LLM is scripted.
import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { OutboxWorker } from "../../src/delivery/worker.js";
import { createFileUrlSigner } from "../../src/files/signing.js";
import { createLogger } from "../../src/log.js";
import { createSessionServices } from "../../src/session/services.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { realClock } from "../../src/voice/clock.js";
import type { LlmRequest, SttEvent, SttProvider, SttStream } from "../../src/voice/types.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { type CheckResult, DEFAULT_LIMITS, type Limits, runE2E } from "./e2e.js";

const WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/** Speech-to-text that listens to loudness: speech start after 60 ms, an interim at 100 ms, a final after 500 ms of quiet. */
class LoudnessStt implements SttProvider {
  deaf = false;
  async open(onEvent: (event: SttEvent) => void): Promise<SttStream> {
    let loud = 0;
    let quiet = 0;
    let speaking = false;
    let closed = false;
    const emit = (event: SttEvent) => {
      if (!closed && !this.deaf) onEvent(event);
    };
    return {
      push: (pcm) => {
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
        if (Math.sqrt(sum / (pcm.length / 2)) > 1_500) {
          loud += 1;
          quiet = 0;
          if (loud === 3) {
            speaking = true;
            emit({ type: "speechStarted" });
          }
          if (loud === 5) emit({ type: "transcript", text: "my screen", isFinal: false, speechFinal: false });
        } else if (speaking && ++quiet >= 25) {
          speaking = false;
          loud = 0;
          emit({ type: "transcript", text: "my screen flickers and goes black", isFinal: true, speechFinal: true });
        }
      },
      close: async () => {
        closed = true;
        onEvent({ type: "closed" });
      },
    };
  }
}

/** The model: greets, asks for the serial number card on the first answer, acknowledges chat events, otherwise talks at length. */
class ScriptedLlm extends FakeLlm {
  asked = false;
  override async stream(request: LlmRequest) {
    const last = request.messages.at(-1);
    const state = [...request.messages].reverse().find((m) => m.role === "system" && m.content.startsWith("STATE "));
    const events = state && state.role === "system" ? ((JSON.parse(state.content.slice(6)) as { newChatEvents?: unknown[] }).newChatEvents ?? []) : [];
    const spoke = request.messages.some((m) => m.role === "user" && !m.content.startsWith("STATE"));
    if (events.length > 0) this.enqueue({ text: "Thanks, I've got your serial number." });
    else if (last?.role === "tool") this.enqueue({ text: "Noted. While you type that, tell me how you use the phone day to day, and when exactly the screen trouble started, please." });
    else if (spoke && !this.asked) {
      this.asked = true;
      this.enqueue({ toolCalls: [{ name: "request_chat_input", args: { field: "serialNumber" } }] });
    } else if (spoke) this.enqueue({ text: "I see. Please tell me a little more about how you use the phone, and whether it was dropped or got wet at any point before this." });
    else this.enqueue({ text: "Hi, I'm Riya from device repairs. What's wrong with your device?" });
    return super.stream(request);
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

interface Deployment {
  url: URL;
  databaseUrl: string;
  stt: LoudnessStt;
  /** Stops the server the way a restart does (sockets get 1012) and starts a new one on the same port and database. */
  restart(): Promise<void>;
  /** Makes the next sessions' cards be refused by nothing, but the record never reach the receiver (a dead webhook). */
  stop(): Promise<void>;
}

async function startDeployment(schema: TestSchema, options: { breakBargeIn?: boolean } = {}): Promise<Deployment> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fileSecret = new Secret(randomBytes(32).toString("hex"));
  const hookSecret = new Secret(randomBytes(32).toString("hex"));
  const stt = new LoudnessStt();
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let outbox: OutboxWorker;

  async function boot() {
    db = schema.open({ max: 10 });
    const logger = createLogger("silent");
    const services = createSessionServices({ pool: db.pool, log: logger, signFileUrl: createFileUrlSigner({ secret: fileSecret, publicOrigin: origin }).sign });
    app = await buildApp({
      logger,
      db,
      webDistDir: WEB_DIST,
      requireWebBuild: true,
      publicOrigin: origin,
      services,
      fileUrlSecret: fileSecret,
      hookSecret,
      uploadsPerMinute: 1000,
      newSessionsPerIpPerHour: 1000,
      apiRateLimitPerMinute: 1000,
      voice: {
        providers: () => ({ stt, tts: new FakeTts({ clock: realClock, charsPerFrame: 2 }), llm: new ScriptedLlm() }),
        maxConcurrentCalls: 2,
        timings: { silenceMs: 120_000 },
        // A system that ignores the user talking over it: the script must notice.
        ...(options.breakBargeIn ? { bargeIn: { minWords: 99, minSpeechMs: 600_000, ignoreAgentMs: 600_000 } } : {}),
      },
    });
    await app.listen({ host: "127.0.0.1", port });
    outbox = new OutboxWorker({ pool: db.pool, log: logger, url: new Secret(`${origin}/hooks/records`), hookSecret });
    services.processor.onOutboxQueued = () => outbox.notify();
    await outbox.start();
  }
  async function halt() {
    await outbox.stop();
    await app.close();
    await db.pool.end().catch(() => {});
  }
  await boot();
  return {
    url: new URL(origin),
    databaseUrl: schema.url,
    stt,
    restart: async () => {
      await halt();
      await boot();
    },
    stop: halt,
  };
}

let schema: TestSchema;

beforeAll(async () => {
  ({ schema } = await createMigratedSchema("deployede2e", { max: 2 }));
});
afterAll(async () => {
  await schema.drop();
});

const quiet = process.env.E2E_VERBOSE ? (line: string) => console.log(line) : () => {};
const byName = (results: CheckResult[], part: string) => results.find((r) => r.name.includes(part));
const passed = (results: CheckResult[]) => results.every((r) => r.status === "pass");
// Local fakes answer quickly; the limits are the plan's, the same ones the deployed run uses.
const LIMITS: Limits = { ...DEFAULT_LIMITS };

describe("the deployed E2E script, against a local deployment with fake providers", () => {
  it("passes every check on a healthy system, and leaves exactly one record and one receiver row", async () => {
    const deployment = await startDeployment(schema);
    try {
      const { results, summary, sessionId } = await runE2E({
        base: deployment.url,
        restart: false,
        noDb: false,
        databaseUrl: deployment.databaseUrl,
        restartService: async () => {},
        limits: LIMITS,
        log: quiet,
      });
      expect(results.filter((r) => r.status !== "pass"), JSON.stringify(results.filter((r) => r.status !== "pass"))).toEqual([]);
      expect(results.length).toBeGreaterThanOrEqual(12);
      expect(summary.stopPlaybackAfterSpeechMs).toBeLessThanOrEqual(1_000);
      expect(summary.acknowledgedField).toBe("serialNumber");
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await deployment.stop();
    }
  }, 120_000);

  it("--restart: the service restarts with the call live, the session resumes in chat, and there is no duplicate record", async () => {
    const deployment = await startDeployment(schema);
    try {
      const { results } = await runE2E({
        base: deployment.url,
        restart: true,
        noDb: false,
        databaseUrl: deployment.databaseUrl,
        restartService: () => deployment.restart(),
        limits: LIMITS,
        log: quiet,
      });
      expect(results.filter((r) => r.status !== "pass"), JSON.stringify(results.filter((r) => r.status !== "pass"))).toEqual([]);
      expect(byName(results, "session is resumed in chat")?.status).toBe("pass");
      expect(byName(results, "receiver holds exactly one row")?.status).toBe("pass");
    } finally {
      await deployment.stop();
    }
  }, 120_000);

  it("fails (and says which check) when the user can't interrupt the agent", async () => {
    const deployment = await startDeployment(schema, { breakBargeIn: true });
    try {
      const { results } = await runE2E({
        base: deployment.url,
        restart: false,
        noDb: true,
        databaseUrl: null,
        restartService: async () => {},
        limits: { ...LIMITS, stopPlaybackAfterSpeechMs: 1_000 },
        log: quiet,
      });
      expect(byName(results, "barge-in")?.status).toBe("fail");
      expect(passed(results)).toBe(false);
    } finally {
      await deployment.stop();
    }
  }, 120_000);

  it("fails when the agent audio arrives later than the limit, and reports a skipped database check as not passing", async () => {
    const deployment = await startDeployment(schema);
    try {
      const { results } = await runE2E({
        base: deployment.url,
        restart: false,
        noDb: true,
        databaseUrl: null,
        restartService: async () => {},
        limits: { ...LIMITS, agentAudioAfterConnectMs: 0 },
        log: quiet,
      });
      expect(results.find((r) => r.name.startsWith("agent audio arrives"))?.status).toBe("fail");
      // A failed first call check ends the run early: nothing after it is claimed.
      expect(results.some((r) => r.name.includes("barge-in"))).toBe(false);
    } finally {
      await deployment.stop();
    }
  }, 60_000);

  it("reports a skipped database check as skipped (the run is then incomplete)", async () => {
    const deployment = await startDeployment(schema);
    try {
      const { results } = await runE2E({
        base: deployment.url,
        restart: false,
        noDb: false,
        databaseUrl: null,
        restartService: async () => {},
        limits: LIMITS,
        log: quiet,
      });
      expect(results.filter((r) => r.status === "fail")).toEqual([]);
      expect(results.filter((r) => r.status === "skip").map((r) => r.detail)).toEqual(["DATABASE_URL is not set"]);
    } finally {
      await deployment.stop();
    }
  }, 120_000);
});
