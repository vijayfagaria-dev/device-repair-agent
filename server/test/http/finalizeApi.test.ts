// POST /api/sessions/:id/finalize (P7-T01): the token-gated test trigger. Off unless ALLOW_TEST_API; a trigger like any
// other (an active session only, the usual dedup), with no way around the rules.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { listRecords } from "../../src/db/repos/records.js";
import { createLogger } from "../../src/log.js";
import type { SessionServices } from "../../src/session/services.js";
import { FAKE } from "../fixtures.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let on: FastifyInstance;
let off: FastifyInstance;
const base = { logger: createLogger("silent"), webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" };

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("finalizeapi"));
  services = testServices(db);
  on = await buildApp({ ...base, db, services, testApiToken: new Secret(FAKE.TEST_API_TOKEN) });
  off = await buildApp({ ...base, db, services });
});
afterAll(async () => {
  await on.close();
  await off.close();
  await schema.drop();
});

const finalize = (id: string, token: string | undefined, app = on) =>
  app.inject({ method: "POST", url: `/api/sessions/${id}/finalize`, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("POST /api/sessions/:id/finalize", () => {
  it("needs the test token", async () => {
    const id = await seedSession(db.pool);
    for (const token of [undefined, "wrong", FAKE.HOOK_SECRET, FAKE.QUOTA_OVERRIDE_TOKEN]) expect((await finalize(id, token)).statusCode, String(token)).toBe(401);
    expect(await listRecords(db.pool, id)).toEqual([]);
  });

  it("is not registered when the test API is off, even with a token", async () => {
    const id = await seedSession(db.pool);
    expect((await finalize(id, FAKE.TEST_API_TOKEN, off)).statusCode).toBe(404);
    expect(await listRecords(db.pool, id)).toEqual([]);
  });

  it("finalizes an active session once; a second call is a no-op", async () => {
    const id = await seedSession(db.pool);
    const first = await finalize(id, FAKE.TEST_API_TOKEN);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ finalized: true, revision: 1, outcome: "partial" });
    expect((await listRecords(db.pool, id)).map((r) => r.revision)).toEqual([1]);
    expect((await finalize(id, FAKE.TEST_API_TOKEN)).json()).toEqual({ finalized: false, reason: "session is finalized" });
    expect(await listRecords(db.pool, id)).toHaveLength(1);
  });

  it("404 for an unknown session, 400 for a malformed id", async () => {
    expect((await finalize(randomUUID(), FAKE.TEST_API_TOKEN)).statusCode).toBe(404);
    expect((await finalize("not-a-uuid", FAKE.TEST_API_TOKEN)).statusCode).toBe(400);
  });
});
