// The free-tier quota guard (P10-T03): budgets read from the real usage ledger in a rolling 24 h window, the provider
// refusal latch, the override, and the wiring: /call closes 4429 `quota` and chat keeps working, sessionState says
// voice is unavailable, the override route is authenticated and rate-limited.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { isProviderRefusal, QuotaGuard, type QuotaSettings } from "../../src/limits/quotaGuard.js";
import { recordUsage, rollingDayUsage } from "../../src/metrics/usage.js";
import type { SessionServices } from "../../src/session/services.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { connect, type RunningApp, startApp } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

const TOKEN = "override-token-0123456789abcdef";
const HOUR = 60 * 60_000;

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let sessionId: string;
const warnings: string[] = [];
const log = { warn: (_o: Record<string, unknown>, message: string) => void warnings.push(message), info: () => {} };

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("quota", { max: 10 }));
  services = testServices(db, { planner: true });
  sessionId = await seedSession(db.pool);
});
afterAll(async () => {
  await schema.drop();
});

async function wipeUsage() {
  await db.pool.query("DELETE FROM usage");
}
const llm = (requests: number, at: Date, model = "openai/gpt-oss-20b", provider: "groq" | "gemini" = "groq") =>
  recordUsage(db.pool, { sessionId, provider, kind: `${model}:requests`, units: requests, at });
const audio = (seconds: number, at: Date) => recordUsage(db.pool, { sessionId, provider: "deepgram", kind: "nova-3:audio", units: seconds, at });

function guard(now: { t: number }, settings: Partial<QuotaSettings> = {}) {
  return new QuotaGuard(db.pool, { llmRequestsPerDay: 10, audioMinutesPerDay: 5, overrideToken: new Secret(TOKEN), ...settings }, log, () => now.t);
}

describe("the budgets", () => {
  it("allows calls below both budgets and refuses at the LLM request budget (per Groq model)", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    await llm(9, new Date(now.t - HOUR));
    expect(await guard(now).check()).toEqual({ ok: true });
    await llm(1, new Date(now.t - 2 * HOUR)); // 10 in the window
    expect(await guard(now).check()).toEqual({ ok: false, reason: "llm_budget" });
  });

  it("counts each Groq model on its own (their limits are per model) and ignores Gemini", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    await llm(6, new Date(now.t - HOUR), "openai/gpt-oss-20b");
    await llm(6, new Date(now.t - HOUR), "openai/gpt-oss-120b");
    await llm(50, new Date(now.t - HOUR), "gemini-flash-lite-latest", "gemini");
    expect(await guard(now).check()).toEqual({ ok: true });
  });

  it("refuses at the audio-minutes budget", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    await audio(4 * 60, new Date(now.t - HOUR));
    expect(await guard(now).check()).toEqual({ ok: true });
    await audio(60, new Date(now.t - HOUR));
    expect(await guard(now).check()).toEqual({ ok: false, reason: "audio_budget" });
  });

  it("uses a rolling 24 h window: usage older than 24 h doesn't count, usage from yesterday evening does", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    await llm(10, new Date(now.t - 25 * HOUR));
    expect(await guard(now).check()).toEqual({ ok: true });
    await llm(10, new Date(now.t - 23 * HOUR)); // possibly "yesterday" in UTC, still inside 24 h
    expect(await guard(now).check()).toEqual({ ok: false, reason: "llm_budget" });
    const usage = await rollingDayUsage(db.pool, new Date(now.t));
    expect(usage.llmRequests["groq:openai/gpt-oss-20b"]).toBe(10);
  });

  it("reads the ledger once per cache window, however many callers ask at once", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    const g = guard(now);
    expect(await g.check()).toEqual({ ok: true });
    await llm(10, new Date(now.t - HOUR));
    expect(await g.check()).toEqual({ ok: true }); // cached
    now.t += 16_000; // past the 15 s window
    expect(await g.check()).toEqual({ ok: false, reason: "llm_budget" });
    expect(g.voiceAvailable()).toBe(false);
    // The budget frees up (the usage ages out of the window); a stale verdict refreshes itself when asked about.
    await wipeUsage();
    now.t += 16_000;
    expect(g.voiceAvailable()).toBe(false); // still the old answer, and a refresh has started
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(g.voiceAvailable()).toBe(true);
    await llm(10, new Date(now.t - HOUR));
    now.t += 16_000;
    await g.check();
    const concurrent = await Promise.all([g.check(), g.check(), g.check()]);
    expect(concurrent.every((v) => !v.ok)).toBe(true);
  });

  it("logs once when the guard starts refusing, and allows calls when the ledger can't be read", async () => {
    await wipeUsage();
    warnings.length = 0;
    const now = { t: Date.now() };
    await llm(10, new Date(now.t - HOUR));
    const g = guard(now);
    await g.check();
    now.t += 16_000;
    await g.check();
    expect(warnings.filter((w) => w.includes("new calls refused"))).toHaveLength(1);
    const broken = new QuotaGuard(
      { query: () => Promise.reject(Object.assign(new Error("db down"), { code: "57P01" })) } as never,
      { llmRequestsPerDay: 1, audioMinutesPerDay: 1, overrideToken: null },
      log,
    );
    expect(await broken.check()).toEqual({ ok: true });
    expect(warnings.some((w) => w.includes("could not read the usage ledger"))).toBe(true);
  });
});

describe("a provider refusing us", () => {
  it("recognises 401/402/403 and ws's refused-upgrade message, and nothing else", () => {
    expect(isProviderRefusal({ status: 401 })).toBe(true);
    expect(isProviderRefusal({ statusCode: 402 })).toBe(true);
    expect(isProviderRefusal(new Error("Unexpected server response: 403"))).toBe(true);
    expect(isProviderRefusal(new Error("Unexpected server response: 4031"))).toBe(false);
    expect(isProviderRefusal({ status: 429 })).toBe(false);
    expect(isProviderRefusal(new Error("Deepgram STT connect timed out"))).toBe(false);
    expect(isProviderRefusal(null)).toBe(false);
  });

  it("latches for the cooldown, then lets calls through again", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    const g = guard(now, { providerCooldownMs: 60_000 });
    g.providerRefused("deepgram");
    expect(await g.check()).toEqual({ ok: false, reason: "provider_unavailable" });
    expect(g.voiceAvailable()).toBe(false);
    now.t += 61_000;
    expect(await g.check()).toEqual({ ok: true });
    expect(g.voiceAvailable()).toBe(true);
  });
});

describe("the override", () => {
  it("lifts a budget refusal and a latch for 24 h, then the guard applies again", async () => {
    await wipeUsage();
    const now = { t: Date.now() };
    await llm(10, new Date(now.t - HOUR));
    const g = guard(now);
    g.providerRefused("deepgram");
    expect((await g.check()).ok).toBe(false);
    expect(g.override("wrong-token-wrong-token-wrong")).toBe(false);
    expect(g.override("")).toBe(false);
    expect((await g.check()).ok).toBe(false);
    expect(g.override(TOKEN)).toBe(true);
    expect(await g.check()).toEqual({ ok: true });
    expect(g.voiceAvailable()).toBe(true);
    now.t += 23 * HOUR;
    expect((await g.check()).ok).toBe(true);
    now.t += 2 * HOUR; // 25 h later the override has lapsed (and the old usage with it, so add some)
    await llm(10, new Date(now.t - HOUR));
    expect((await g.check()).ok).toBe(false);
  });

  it("can't be used when no token is configured", () => {
    const g = guard({ t: Date.now() }, { overrideToken: null });
    expect(g.canOverride).toBe(false);
    expect(g.override(TOKEN)).toBe(false);
  });
});

describe("over real sockets", () => {
  let server: RunningApp;
  let g: QuotaGuard;
  let stt: FakeStt;

  beforeAll(async () => {
    await wipeUsage();
    g = new QuotaGuard(db.pool, { llmRequestsPerDay: 5, audioMinutesPerDay: 5, overrideToken: new Secret(TOKEN), cacheMs: 0 }, log);
    server = await startApp(db, {
      services,
      quota: g,
      voice: {
        providers: () => {
          stt = new FakeStt();
          const fake = new FakeLlm();
          fake.fallback = { text: "Okay." };
          return { stt, tts: new FakeTts(), llm: fake };
        },
        maxConcurrentCalls: 5,
        timings: { silenceMs: 60_000 },
        quota: g,
      },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const state = (socket: ReturnType<typeof connect>) => (socket.messages as { type: string; voiceAvailable?: boolean }[]).filter((m) => m.type === "sessionState").at(-1);

  it("under budget: the call starts and sessionState says voice is available", async () => {
    const id = randomUUID();
    const chat = connect(`${server.ws}/chat?sessionId=${id}`);
    await chat.opened;
    await chat.waitForMessages(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(state(chat)?.voiceAvailable).toBe(true);
    const call = connect(`${server.ws}/call?sessionId=${id}`);
    await call.opened;
    const outcome = await Promise.race([call.closed, new Promise<"open">((r) => setTimeout(() => r("open"), 500))]);
    expect(outcome).toBe("open");
    call.ws.close(1000);
    chat.ws.close();
  });

  it("over budget: /call closes 4429 `quota`, no call is started, and the chat still works and says voice is unavailable", async () => {
    await llm(5, new Date(Date.now() - HOUR));
    const id = randomUUID();
    const call = connect(`${server.ws}/call?sessionId=${id}`);
    await call.opened;
    expect(await call.closed).toEqual({ code: 4429, reason: "quota" });
    const { rows } = await db.pool.query("SELECT active_call_id FROM sessions WHERE id = $1", [id]);
    expect(rows[0]?.active_call_id ?? null).toBeNull();

    const chat = connect(`${server.ws}/chat?sessionId=${id}`);
    await chat.opened;
    await chat.waitForMessages(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(state(chat)?.voiceAvailable).toBe(false);
    expect(chat.messages.some((m) => (m as { type: string }).type === "syncDone")).toBe(true);
    chat.ws.close();
  });

  it("a refused Deepgram key at call start latches the guard for the next callers", async () => {
    await wipeUsage();
    const latch = new QuotaGuard(db.pool, { llmRequestsPerDay: 5, audioMinutesPerDay: 5, overrideToken: null, cacheMs: 0 }, log);
    const refusing = await startApp(db, {
      services,
      quota: latch,
      voice: {
        providers: () => ({
          stt: { open: () => Promise.reject(new Error("Unexpected server response: 402")) },
          tts: new FakeTts(),
          llm: new FakeLlm(),
        }),
        maxConcurrentCalls: 5,
        quota: latch,
      },
    });
    try {
      const first = connect(`${refusing.ws}/call?sessionId=${randomUUID()}`);
      await first.opened;
      await first.closed;
      expect(latch.voiceAvailable()).toBe(false);
      const second = connect(`${refusing.ws}/call?sessionId=${randomUUID()}`);
      await second.opened;
      expect(await second.closed).toEqual({ code: 4429, reason: "quota" });
    } finally {
      await refusing.close();
    }
  });

  it("POST /api/quota/override: 401 without or with a wrong token, 200 with the token, which re-opens voice", async () => {
    await llm(5, new Date(Date.now() - HOUR));
    const url = `${server.http}/api/quota/override`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: TOKEN } })).status).toBe(401);
    const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ overridden: true });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const call = connect(`${server.ws}/call?sessionId=${randomUUID()}`);
    await call.opened;
    expect(await Promise.race([call.closed, new Promise<"open">((r) => setTimeout(() => r("open"), 400))])).toBe("open");
    call.ws.close(1000);
  });

  it("the override route is rate-limited (5 tries a minute) and absent when no token is configured", async () => {
    const url = `${server.http}/api/quota/override`;
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" } })).status);
    expect(codes).toContain(429);
    const bare = await startApp(db, { services });
    try {
      expect((await fetch(`${bare.http}/api/quota/override`, { method: "POST" })).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
