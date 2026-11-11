// GET /api/sessions/:id, /timeline, /records (P3-T02): DTOs, 404/400, no secrets, internal paths or provider ids,
// and the per-IP rate limit. Driven with fastify.inject against the throwaway test Postgres.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/pool.js";
import { appendEvent } from "../../src/db/repos/events.js";
import { insertRecord } from "../../src/db/repos/records.js";
import { lockSession } from "../../src/db/repos/sessions.js";
import { withTx } from "../../src/db/tx.js";
import { createLogger } from "../../src/log.js";
import { recordUsage } from "../../src/metrics/usage.js";
import type { SessionServices } from "../../src/session/services.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { expectNoLeaks, expectSanitizedRecord } from "../helpers/recordOracle.js";
import { HASH, seedSession } from "../helpers/seed.js";
import { seedCall, testServices } from "../helpers/session.js";
import { SCENARIOS } from "../domain/scenarios.js";
import { buildRecord } from "../../src/domain/record.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let app: FastifyInstance;
const base = { logger: createLogger("silent"), webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" };

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("sessread"));
  services = testServices(db);
  app = await buildApp({ ...base, db, services, apiRateLimitPerMinute: 1000 });
});
afterAll(async () => {
  await app.close();
  await schema.drop();
});

const get = (url: string, target = app) => target.inject({ method: "GET", url });

/** A session with a bit of everything: chat, a call line, cards, candidates (incl. a conflict and a file), usage. */
async function richSession(): Promise<string> {
  const id = await seedSession(db.pool);
  const run = (command: object) => services.processor.dispatch(id, command as never);
  const callId = `c${id.slice(0, 8)}`;
  await seedCall(db, id, callId);
  await run({ type: "Test.Say", messageId: `msg${callId}`, text: "Hi, I'm the claims assistant." });
  await run({ type: "Test.Transcript", lineId: `tu_${callId}_1`, callId, text: "It's an iPhone 14 Pro" });
  await run({ type: "Test.Candidate", field: "deviceType", source: "call", raw: "phone", normalized: "smartphone", evidence: "user: it's my phone" });
  await run({ type: "Test.Candidate", field: "email", source: "call", raw: "asha@example.com", normalized: "asha@example.com", status: "unverified" });
  await run({ type: "Test.Candidate", field: "email", source: "chat", raw: "other@example.com", normalized: "other@example.com" });
  await run({ type: "Test.Candidate", field: "purchaseInvoice", source: "chat", raw: "file:fInv0000001", normalized: { fileId: "fInv0000001", mime: "application/pdf", size: 1200, sha256: "c".repeat(64), path: "/var/data/x.pdf" } });
  await run({ type: "Test.OpenCard", requestId: "req_serialNumber_1", field: "serialNumber" });
  await recordUsage(db.pool, { sessionId: id, provider: "deepgram", kind: "nova-3:audio", units: 60 });
  // An event payload that (wrongly) carries secrets and provider ids must not leak through the timeline.
  await withTx(db.pool, async (tx) => {
    await lockSession(tx, id);
    await appendEvent(tx, {
      sessionId: id,
      type: "agent.turn",
      channel: "call",
      payload: {
        ttftMs: 640,
        promptTokens: 812, // a count, not a credential: kept
        providerRequestId: "req-groq-123",
        providerCallId: "dg-call-456",
        apiKey: "sk-not-real",
        access_token: "at-not-real",
        nested: { authorization: "Bearer x", filePath: "/tmp/a", file_path: "/tmp/b", storagePath: "/tmp/c", storageKey: "bucket/key-1", keep: 1 },
      },
    });
  });
  return id;
}

describe("GET /api/sessions/:id", () => {
  it("returns the state with every field's effective value from the resolver", async () => {
    const id = await richSession();
    const res = await get(`/api/sessions/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ sessionId: id, status: "active", outcome: null, revision: null, callActive: false, openRequest: { id: "req_serialNumber_1", field: "serialNumber" } });
    expect(body.fields.deviceType).toMatchObject({ value: "smartphone", source: "call", status: "valid" });
    expect(body.fields.email).toMatchObject({ value: "other@example.com", source: "chat", status: "valid" }); // typed beats spoken (D15)
    expect(body.fields.serialNumber).toEqual({ value: null, source: null, collectedAt: null, status: "missing" });
    expect(body.fields.purchaseInvoice.value).toEqual({ fileId: "fInv0000001", mime: "application/pdf", size: 1200, sha256: "c".repeat(64) }); // no url, no path
    expect(body.missingRequired).toContain("serialNumber");
    expect(body.missingRequired).not.toContain("email");
    expect(body.conflicts).toEqual([expect.objectContaining({ field: "email", resolution: "chatValue", callValue: "asha@example.com", chatValue: "other@example.com" })]);
    expect(Object.keys(body.fields)).toHaveLength(11);
  });

  it("returns 404 for an unknown id and 400 for a malformed one, creating nothing", async () => {
    const before = (await db.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
    for (const path of ["", "/timeline", "/records"]) {
      const unknown = await get(`/api/sessions/${randomUUID()}${path}`);
      expect(unknown.statusCode, path).toBe(404);
      expect(unknown.json()).toEqual({ error: "not_found", message: "No such session." });
      expect((await get(`/api/sessions/not-a-uuid${path}`)).statusCode, path).toBe(400);
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(before);
  });

  it("is a read: it never counts as activity or changes the session", async () => {
    const id = await richSession();
    const before = (await db.pool.query("SELECT version, last_activity_at FROM sessions WHERE id = $1", [id])).rows[0];
    await get(`/api/sessions/${id}`);
    await get(`/api/sessions/${id}/timeline`);
    expect((await db.pool.query("SELECT version, last_activity_at FROM sessions WHERE id = $1", [id])).rows[0]).toEqual(before);
  });
});

describe("GET /api/sessions/:id/timeline", () => {
  it("returns events, transcript and cost, without secrets, internal paths, provider ids or LLM evidence", async () => {
    const id = await richSession();
    const res = await get(`/api/sessions/${id}/timeline`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      "chat.message",
      "transcript.final",
      "field.candidate",
      "field.candidate",
      "field.candidate",
      "field.candidate",
      "input.requested",
      "agent.turn",
    ]);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const callId = `c${id.slice(0, 8)}`;
    expect(body.transcript).toEqual([expect.objectContaining({ id: `tu_${callId}_1`, callId, role: "user", text: "It's an iPhone 14 Pro" })]);
    expect(body.cost.costUsd).toBeCloseTo(0.0077, 8);
    expect(body.usage).toEqual([expect.objectContaining({ provider: "deepgram", kind: "nova-3:audio", units: 60, unit: "second" })]);
    expect(body.events.at(-1).payload).toEqual({ ttftMs: 640, promptTokens: 812, nested: { keep: 1 } });

    const text = res.body;
    for (const leak of ["req-groq-123", "dg-call-456", "sk-not-real", "at-not-real", "Bearer x", "/tmp/a", "/tmp/b", "/tmp/c", "bucket/key-1", "/var/data", "user: it's my phone"]) expect(text, leak).not.toContain(leak);
  });
});

describe("GET /api/sessions/:id/records", () => {
  it("lists the immutable revisions, oldest first", async () => {
    const id = await seedSession(db.pool);
    expect((await get(`/api/sessions/${id}/records`)).json()).toEqual({ sessionId: id, records: [] });
    await insertRecord(db.pool, { sessionId: id, revision: 1, outcome: "partial" as never, payload: { revision: 1 }, contentHash: HASH });
    await insertRecord(db.pool, { sessionId: id, revision: 2, outcome: "completed" as never, payload: { revision: 2 }, contentHash: "1".repeat(64) });
    const body = (await get(`/api/sessions/${id}/records`)).json();
    expect(body.records.map((r: { revision: number; outcome: string }) => [r.revision, r.outcome])).toEqual([
      [1, "partial"],
      [2, "completed"],
    ]);
    expect(body.records[1].record).toEqual({ revision: 2 });
  });
});

describe("rate limit", () => {
  it("allows the configured requests per IP per minute, then 429 with a JSON error; other routes aren't limited", async () => {
    const limited = await buildApp({ ...base, db, services, apiRateLimitPerMinute: 3 });
    try {
      const id = await seedSession(db.pool);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await get(`/api/sessions/${id}`, limited)).statusCode);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const refused = await get(`/api/sessions/${id}/records`, limited);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/^Too many requests/) });
      // Another client IP has its own budget; health checks are never limited.
      expect((await limited.inject({ method: "GET", url: `/api/sessions/${id}`, remoteAddress: "10.0.0.9" })).statusCode).toBe(200);
      for (let i = 0; i < 5; i++) expect((await get("/healthz", limited)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe("sanitization oracle (P6-T02) on the DTOs", () => {
  const secrets = FAKE_SECRET_VALUES;

  it("state and timeline: no leak of any class, on a session holding a file, a conflict and a hostile event payload", async () => {
    const id = await richSession();
    expectNoLeaks((await get(`/api/sessions/${id}`)).json(), { secrets });
    const timeline = (await get(`/api/sessions/${id}/timeline`)).json();
    expectNoLeaks(timeline, { secrets });
    // The upload ref the page sent ("file:<id>") is shown as the bare file id.
    const invoice = timeline.events.find((e: { payload: { candidate?: { field?: string } } }) => e.payload.candidate?.field === "purchaseInvoice");
    expect(invoice.payload.candidate.raw).toBe("fInv0000001");
  });

  it("records: every revision passes the record oracle, and the envelope leaks nothing but the records' signed links", async () => {
    const id = await seedSession(db.pool);
    const built = (["partial", "completed"] as const).map((name, i) => buildRecord({ ...SCENARIOS[name](), sessionId: id, revision: i + 1 }));
    for (const { record, contentHash } of built) {
      await insertRecord(db.pool, { sessionId: id, revision: record.revision, outcome: record.outcome, payload: record as never, contentHash });
    }
    const body = (await get(`/api/sessions/${id}/records`)).json();
    expect(body.records).toHaveLength(2);
    for (const entry of body.records) expectSanitizedRecord(entry.record, { secrets });
    expectNoLeaks(body, { secrets }, true);
  });
});
