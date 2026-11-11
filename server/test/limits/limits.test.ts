// P10-T03 acceptance: each limit, when exceeded, gives its documented response AND a log line. One test per limit, with a
// capturing logger: the read-API rate limit (429), the upload rate limit (429), the concurrent-upload limit (429), the
// upload budget (507), the concurrent-call cap (4429 capacity), the maximum call duration (1000 "max duration"), the new-
// session rate limit (4429 rate limited), the override route's rate limit (429). The quota guard's own refusal (4429
// quota) and its log lines are in quotaGuard.test.ts.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { Secret } from "../../src/config.js";
import { QuotaGuard } from "../../src/limits/quotaGuard.js";
import { connect, type RunningApp, startApp } from "../helpers/app.js";
import { PDF } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { testServices } from "../helpers/session.js";
import { TEST_FILE_URL_SECRET } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
const lines: { msg?: string; level?: string; [key: string]: unknown }[] = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
    done();
  },
});
const logged = (message: string) => lines.some((l) => l.msg === message);

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("limits", { max: 10 }));
});
afterAll(async () => {
  await schema.drop();
});

const voice = (overrides: Record<string, unknown> = {}) => ({
  providers: () => ({ stt: new FakeStt(), tts: new FakeTts(), llm: Object.assign(new FakeLlm(), { fallback: { text: "Okay." } }) }),
  maxConcurrentCalls: 1,
  timings: { silenceMs: 60_000 },
  ...overrides,
});
async function app(options: Parameters<typeof startApp>[1] = {}): Promise<RunningApp> {
  return startApp(db, { logger: createLogger("info", sink), services: testServices(db, { planner: true }), ...options });
}
const upload = (server: RunningApp, id: string) => {
  const body = new FormData();
  body.append("file", new Blob([PDF], { type: "application/pdf" }), "a.pdf");
  return fetch(`${server.http}/sessions/${id}/files`, { method: "POST", body });
};

describe("each limit gives its documented response and a log line", () => {
  it("read API: 429 rate_limited", async () => {
    const server = await app({ apiRateLimitPerMinute: 2 });
    try {
      const id = randomUUID();
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await fetch(`${server.http}/api/sessions/${id}`)).status);
      expect(codes.slice(2)).toEqual([429, 429]);
      expect(logged("rate limit exceeded")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("uploads per minute: 429 rate_limited", async () => {
    lines.length = 0;
    const server = await app({ fileUrlSecret: TEST_FILE_URL_SECRET, uploadsPerMinute: 1 });
    try {
      const id = randomUUID();
      expect((await upload(server, id)).status).toBe(200);
      const second = await upload(server, id);
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
      expect(logged("rate limit exceeded")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the upload budget: 507 storage_budget", async () => {
    lines.length = 0;
    const server = await app({ fileUrlSecret: TEST_FILE_URL_SECRET, uploadBudgetBytes: 1 });
    try {
      const response = await upload(server, randomUUID());
      expect(response.status).toBe(507);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage_budget");
      expect(lines.some((l) => String(l.msg).startsWith("upload refused: the global upload budget"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the concurrent-call cap: 4429 capacity", async () => {
    lines.length = 0;
    const server = await app({ voice: voice() });
    try {
      const first = connect(`${server.ws}/call?sessionId=${randomUUID()}`);
      await first.opened;
      await new Promise((r) => setTimeout(r, 300));
      const second = connect(`${server.ws}/call?sessionId=${randomUUID()}`);
      await second.opened;
      expect(await second.closed).toEqual({ code: 4429, reason: "capacity" });
      expect(logged("call refused: capacity")).toBe(true);
      first.ws.close(1000);
      await first.closed;
    } finally {
      await server.close();
    }
  });

  it("the maximum call duration: closed 1000 'max duration', logged", async () => {
    lines.length = 0;
    const server = await app({ voice: voice({ timings: { silenceMs: 60_000, maxCallMs: 300 } }) });
    try {
      const call = connect(`${server.ws}/call?sessionId=${randomUUID()}`);
      await call.opened;
      expect(await call.closed).toEqual({ code: 1000, reason: "max duration" });
      await new Promise((r) => setTimeout(r, 200));
      expect(lines.some((l) => l.msg === "call ended" && l.reason === "max_duration")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("new sessions per IP: 4429 rate limited", async () => {
    lines.length = 0;
    const server = await app({ newSessionsPerIpPerHour: 1 });
    try {
      const first = connect(`${server.ws}/chat?sessionId=${randomUUID()}`);
      await first.opened;
      const second = connect(`${server.ws}/chat?sessionId=${randomUUID()}`);
      await second.opened;
      expect(await second.closed).toEqual({ code: 4429, reason: "rate limited" });
      expect(logged("websocket refused: new-session rate limit")).toBe(true);
      first.ws.close();
    } finally {
      await server.close();
    }
  });

  it("the quota-override route: 429 after five attempts a minute", async () => {
    lines.length = 0;
    const guard = new QuotaGuard(db.pool, { llmRequestsPerDay: 5, audioMinutesPerDay: 5, overrideToken: new Secret("t".repeat(32)) }, { warn: () => {}, info: () => {} });
    const server = await app({ quota: guard });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await fetch(`${server.http}/api/quota/override`, { method: "POST" })).status);
      expect(codes.filter((c) => c === 401)).toHaveLength(5);
      expect(codes.slice(5)).toEqual([429, 429]);
      expect(logged("rate limit exceeded")).toBe(true);
      expect(logged("quota override refused")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
