// POST /api/sessions: token-gated test API (P1-T03 step 4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { parseSessionId } from "@device-repair/shared/protocol";
import { buildApp } from "../../src/app.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { hasBearerToken } from "../../src/http/sessions.js";
import { createLogger } from "../../src/log.js";
import { FAKE } from "../fixtures.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let db: Database;
let enabled: FastifyInstance;
let disabled: FastifyInstance;
const token = new Secret(FAKE.TEST_API_TOKEN);
const base = { logger: createLogger("silent"), webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" };

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("testapi"));
  enabled = await buildApp({ ...base, db, testApiToken: token, newSessionsPerIpPerHour: 1 });
  disabled = await buildApp({ ...base, db, testApiToken: null });
});
afterAll(async () => {
  await enabled.close();
  await disabled.close();
  await schema.drop();
});

const post = (app: FastifyInstance, authorization?: string) =>
  app.inject({ method: "POST", url: "/api/sessions", headers: authorization ? { authorization } : {} });

describe("POST /api/sessions", () => {
  it("doesn't exist unless the test API is enabled", async () => {
    const res = await post(disabled, `Bearer ${FAKE.TEST_API_TOKEN}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("rejects a missing or wrong token without creating anything", async () => {
    const before = (await db.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
    for (const header of [undefined, "Bearer", "Bearer ", `Bearer ${FAKE.TEST_API_TOKEN}x`, FAKE.TEST_API_TOKEN, `Basic ${FAKE.TEST_API_TOKEN}`]) {
      const res = await post(enabled, header);
      expect(res.statusCode, String(header)).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(before);
  });

  it("creates a session with a server-generated UUIDv4 and returns it", async () => {
    const res = await post(enabled, `Bearer ${FAKE.TEST_API_TOKEN}`);
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { sessionId } = res.json() as { sessionId: string };
    expect(parseSessionId(sessionId)).toBe(sessionId);
    expect(await getSession(db.pool, sessionId)).not.toBeNull();
    expect(await listEvents(db.pool, sessionId)).toMatchObject([{ type: "session.created", payload: { via: "testApi" } }]);
  });

  it("isn't subject to the browser's per-IP creation limit (it is token-gated)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await post(enabled, `Bearer ${FAKE.TEST_API_TOKEN}`)).json().sessionId);
    expect(ids.size).toBe(5);
  });
});

describe("hasBearerToken", () => {
  it("accepts only the exact token", () => {
    expect(hasBearerToken(`Bearer ${FAKE.TEST_API_TOKEN}`, token)).toBe(true);
    expect(hasBearerToken(`bearer ${FAKE.TEST_API_TOKEN}`, token)).toBe(false);
    expect(hasBearerToken(`Bearer ${FAKE.TEST_API_TOKEN.slice(0, -1)}`, token)).toBe(false);
    expect(hasBearerToken(undefined, token)).toBe(false);
  });
});
