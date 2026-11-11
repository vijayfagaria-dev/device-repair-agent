// Lazy session creation against the test Postgres (P1-T03).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { CreationLimiter } from "../../src/session/creationLimit.js";
import { ensureSession } from "../../src/session/ensureSession.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let db: Database;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("ensure"));
});
afterAll(async () => {
  await schema.drop();
});

const limiter = (max: number) => new CreationLimiter({ max, windowMs: 60_000 });

describe("ensureSession", () => {
  it("creates an unknown session with defaults and one session.created event", async () => {
    const id = randomUUID();
    const result = await ensureSession(db.pool, id, { via: "chat" });
    expect(result).toMatchObject({ ok: true, created: true, session: { id, status: "active", version: 0, outcome: null } });
    expect(await getSession(db.pool, id)).not.toBeNull();
    const events = await listEvents(db.pool, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: "session.created", channel: "system", payload: { via: "chat" } });
  });

  it("loads an existing session without writing anything", async () => {
    const id = randomUUID();
    await ensureSession(db.pool, id, { via: "chat" });
    const before = await getSession(db.pool, id);
    const result = await ensureSession(db.pool, id, { via: "call" });
    expect(result).toMatchObject({ ok: true, created: false });
    expect(await getSession(db.pool, id)).toEqual(before); // version and last activity untouched (not user activity)
    expect(await listEvents(db.pool, id)).toHaveLength(1);
  });

  it("creates a new id exactly once under 12 concurrent calls", async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => ensureSession(db.pool, id, { via: "chat" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await listEvents(db.pool, id)).toHaveLength(1);
  });

  describe("rate limit", () => {
    it("refuses new sessions beyond the limit for that key, creating nothing", async () => {
      const l = limiter(2);
      for (let i = 0; i < 2; i++) expect((await ensureSession(db.pool, randomUUID(), { via: "chat", limit: { limiter: l, key: "1.2.3.4" } })).ok).toBe(true);
      const refusedId = randomUUID();
      expect(await ensureSession(db.pool, refusedId, { via: "chat", limit: { limiter: l, key: "1.2.3.4" } })).toEqual({ ok: false, reason: "rate_limited" });
      expect(await getSession(db.pool, refusedId)).toBeNull();
      // Another client is unaffected.
      expect((await ensureSession(db.pool, randomUUID(), { via: "chat", limit: { limiter: l, key: "5.6.7.8" } })).ok).toBe(true);
    });

    it("never limits loading an existing session", async () => {
      const l = limiter(1);
      const id = randomUUID();
      await ensureSession(db.pool, id, { via: "chat", limit: { limiter: l, key: "k" } });
      for (let i = 0; i < 5; i++) {
        expect(await ensureSession(db.pool, id, { via: "chat", limit: { limiter: l, key: "k" } })).toMatchObject({ ok: true, created: false });
      }
    });

    it("doesn't charge a call that joined a session someone else created concurrently", async () => {
      const l = limiter(1);
      const id = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ensureSession(db.pool, id, { via: "chat", limit: { limiter: l, key: "k2" } })),
      );
      // All six get the session (the losers either joined after the insert or re-read it after the limit refused them).
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
      // Exactly one slot was used: the next new session is refused.
      expect((await ensureSession(db.pool, randomUUID(), { via: "chat", limit: { limiter: l, key: "k2" } })).ok).toBe(false);
    });
  });

  it("rolls back completely and returns the slot when the event can't be written", async () => {
    const broken = await createMigratedSchema("ensure_broken");
    try {
      // Make appendEvent fail inside the transaction, after the session insert.
      await broken.db.pool.query("ALTER TABLE events RENAME TO events_gone");
      const l = limiter(1);
      const id = randomUUID();
      await expect(ensureSession(broken.db.pool, id, { via: "chat", limit: { limiter: l, key: "k" } })).rejects.toThrow(/events/);
      expect(await getSession(broken.db.pool, id)).toBeNull(); // no session without its event
      expect(l.tryAcquire("k")).toBe(true); // the slot came back
      expect(broken.db.pool.idleCount).toBe(broken.db.pool.totalCount); // no leaked client
    } finally {
      await broken.schema.drop();
    }
  });
});
