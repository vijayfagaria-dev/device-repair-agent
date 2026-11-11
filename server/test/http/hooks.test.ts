// The stub record receiver (P7-T04): idempotent storage, the secret, the key checks, the token-gated listing.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { listReceivedRecords } from "../../src/db/repos/receivedRecords.js";
import { buildRecord } from "../../src/domain/record.js";
import { createLogger } from "../../src/log.js";
import { SCENARIOS } from "../domain/scenarios.js";
import { FAKE } from "../fixtures.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";

let schema: TestSchema;
let db: Database;
let app: FastifyInstance;
let withoutTestApi: FastifyInstance;
const hookSecret = new Secret(FAKE.HOOK_SECRET);
const testApiToken = new Secret(FAKE.TEST_API_TOKEN);
const base = { logger: createLogger("silent"), webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" };

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("hooks"));
  app = await buildApp({ ...base, db, hookSecret, testApiToken });
  withoutTestApi = await buildApp({ ...base, db, hookSecret });
});
afterAll(async () => {
  await app.close();
  await withoutTestApi.close();
  await schema.drop();
});

function delivery(revision = 1) {
  const sessionId = randomUUID();
  const { record } = buildRecord({ ...SCENARIOS.partial(), sessionId, revision });
  return { sessionId, record, key: `${sessionId}:${revision}` };
}
const post = (key: string | undefined, body: unknown, secret: string | null = FAKE.HOOK_SECRET, target = app) =>
  target.inject({
    method: "POST",
    url: "/hooks/records",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...(secret ? { "x-hook-secret": secret } : {}) },
    payload: JSON.stringify(body),
  });
const stored = async (key: string) => (await listReceivedRecords(db.pool)).find((r) => r.idempotencyKey === key);

describe("POST /hooks/records", () => {
  it("3 identical deliveries give one row with times_received = 3, all answered 200; the first payload is kept", async () => {
    const { record, key } = delivery();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(key, record)).statusCode);
    expect(statuses).toEqual([200, 200, 200]);
    const row = await stored(key);
    expect(row).toMatchObject({ idempotencyKey: key, timesReceived: 3, payload: record });
    expect((await listReceivedRecords(db.pool)).filter((r) => r.idempotencyKey === key)).toHaveLength(1);
    expect((await post(key, record)).json()).toEqual({ stored: true, timesReceived: 4 });
  });

  it("a wrong or missing secret is 401 and stores nothing, whatever the body", async () => {
    const { record, key } = delivery();
    for (const secret of [null, "", "wrong", `${FAKE.HOOK_SECRET}x`, FAKE.HOOK_SECRET.slice(1), FAKE.TEST_API_TOKEN]) {
      const res = await post(key, record, secret);
      expect(res.statusCode, String(secret)).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await post(key, "{not json", "wrong")).statusCode).toBe(401); // refused before the body is read
    expect(await stored(key)).toBeUndefined();
  });

  it("rejects a missing or malformed key, a key that doesn't match the record, and a record that breaks the schema", async () => {
    const { record, key, sessionId } = delivery(2);
    expect((await post(undefined, record)).statusCode).toBe(400);
    for (const bad of ["nope", `${sessionId}`, `${sessionId}:0`, `${sessionId}:x`, `not-a-uuid:2`]) expect((await post(bad, record)).statusCode, bad).toBe(400);
    expect((await post(`${sessionId}:3`, record)).json()).toMatchObject({ error: "key_mismatch" });
    expect((await post(`${randomUUID()}:2`, record)).json()).toMatchObject({ error: "key_mismatch" });
    const broken = await post(key, { ...record, outcome: "banana", extra: "/data/x" });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: "invalid_record" });
    expect(broken.body).not.toMatch(/banana|\/data\/x/); // paths and keywords only
    expect(await stored(key)).toBeUndefined();
  });

  it("a different revision of the same session is a different key (two rows)", async () => {
    const sessionId = randomUUID();
    for (const revision of [1, 2]) {
      const { record } = buildRecord({ ...SCENARIOS.partial(), sessionId, revision });
      expect((await post(`${sessionId}:${revision}`, record)).statusCode).toBe(200);
    }
    expect(((await listReceivedRecords(db.pool)).filter((r) => r.idempotencyKey.startsWith(sessionId))).map((r) => r.timesReceived)).toEqual([1, 1]);
  });

  it("caps the body it will read", async () => {
    const { key } = delivery();
    expect((await post(key, { filler: "x".repeat(300_000) })).statusCode).toBe(413);
  });
});

describe("GET /hooks/records", () => {
  it("lists what was received, only with the test token", async () => {
    const { record, key } = delivery();
    await post(key, record);
    const get = (headers: Record<string, string>, target = app) => target.inject({ method: "GET", url: "/hooks/records", headers });
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await get({ authorization: `Bearer ${FAKE.HOOK_SECRET}` })).statusCode).toBe(401); // the hook secret is not the test token
    const res = await get({ authorization: `Bearer ${FAKE.TEST_API_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const mine = (res.json() as { records: { idempotencyKey: string; timesReceived: number; record: unknown }[] }).records.find((r) => r.idempotencyKey === key);
    expect(mine).toMatchObject({ timesReceived: 1, record });
    expectSanitizedRecord(mine?.record, { secrets: [FAKE.HOOK_SECRET, FAKE.TEST_API_TOKEN] });
  });

  it("does not exist when the test API is off (and POST still works)", async () => {
    expect((await withoutTestApi.inject({ method: "GET", url: "/hooks/records", headers: { authorization: `Bearer ${FAKE.TEST_API_TOKEN}` } })).statusCode).toBe(404);
    const { record, key } = delivery();
    expect((await post(key, record, FAKE.HOOK_SECRET, withoutTestApi)).statusCode).toBe(200);
  });
});
