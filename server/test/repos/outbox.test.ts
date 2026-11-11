import { Outcome } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { claimDueOutbox, insertOutbox, listOutbox, saveOutbox } from "../../src/db/repos/outbox.js";
import { insertRecord } from "../../src/db/repos/records.js";
import { withTx } from "../../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { barrier, HASH, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: Database;
  ({ schema, db } = await createMigratedSchema("rout", { max: 8 }));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const T0 = new Date("2026-11-08T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

async function sessionWithRecord(revisions = 1): Promise<string> {
  const id = await seedSession(pool);
  for (let revision = 1; revision <= revisions; revision++) {
    await insertRecord(pool, { sessionId: id, revision, outcome: Outcome.COMPLETED, payload: {}, contentHash: HASH });
  }
  return id;
}

// Claim tests share the outbox table; each starts from an empty one (the outbox is not append-only).
async function clear(): Promise<void> {
  await pool.query("DELETE FROM outbox");
}

describe("outbox repo", () => {
  it("insertOutbox queues a pending delivery for an existing revision", async () => {
    const id = await sessionWithRecord();
    const row = await insertOutbox(pool, { sessionId: id, revision: 1, target: "webhook" });
    expect(row).toMatchObject({ sessionId: id, revision: 1, target: "webhook", status: "pending", attempts: 0, lastError: null, deliveredAt: null });
    expect(typeof row.id).toBe("number");
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    await expect(insertOutbox(pool, { sessionId: id, revision: 1, target: "webhook" })).rejects.toMatchObject({ code: "23505" });
    await expect(insertOutbox(pool, { sessionId: id, revision: 9, target: "webhook" })).rejects.toMatchObject({ code: "23503" });
  });

  it("saveOutbox writes the delivery state; null for an unknown id", async () => {
    const id = await sessionWithRecord();
    const row = await insertOutbox(pool, { sessionId: id, revision: 1, target: "webhook", nextAttemptAt: T0 });
    const failed = await saveOutbox(pool, { id: row.id, status: "sending", attempts: 1, nextAttemptAt: at(30), lastError: "HTTP 503", deliveredAt: null });
    expect(failed).toMatchObject({ status: "sending", attempts: 1, nextAttemptAt: at(30), lastError: "HTTP 503", deliveredAt: null });
    const done = await saveOutbox(pool, { id: row.id, status: "delivered", attempts: 2, nextAttemptAt: at(30), lastError: null, deliveredAt: at(31) });
    expect(done).toMatchObject({ status: "delivered", attempts: 2, lastError: null, deliveredAt: at(31) });
    expect(await saveOutbox(pool, { id: 987654321, status: "dead", attempts: 1, nextAttemptAt: T0, lastError: null, deliveredAt: null })).toBeNull();
  });

  it("listOutbox returns the session's rows by revision and target", async () => {
    const id = await sessionWithRecord(2);
    await insertOutbox(pool, { sessionId: id, revision: 2, target: "webhook" });
    await insertOutbox(pool, { sessionId: id, revision: 1, target: "webhook" });
    await insertOutbox(pool, { sessionId: id, revision: 1, target: "console" });
    expect((await listOutbox(pool, id)).map((r) => `${r.revision}:${r.target}`)).toEqual(["1:console", "1:webhook", "2:webhook"]);
  });

  it("claimDueOutbox returns due pending/sending rows, oldest first; never delivered, dead or future rows", async () => {
    await clear();
    const id = await sessionWithRecord();
    const rows = [];
    for (const [target, due, status] of [
      ["a", -30, "pending"],
      ["b", -60, "sending"],
      ["c", -90, "delivered"],
      ["d", -90, "dead"],
      ["e", 30, "pending"],
    ] as const) {
      const row = await insertOutbox(pool, { sessionId: id, revision: 1, target, nextAttemptAt: at(due) });
      if (status !== "pending") await saveOutbox(pool, { ...row, status, deliveredAt: null });
      rows.push(row);
    }
    expect((await withTx(pool, (tx) => claimDueOutbox(tx, { now: T0, limit: 10 }))).map((r) => r.target)).toEqual(["b", "a"]);
    expect((await withTx(pool, (tx) => claimDueOutbox(tx, { now: T0, limit: 1 }))).map((r) => r.target)).toEqual(["b"]);
    await expect(withTx(pool, (tx) => claimDueOutbox(tx, { now: T0, limit: 1.5 }))).rejects.toBeInstanceOf(RangeError);
  });

  it("SKIP LOCKED: concurrent claimers (two pools, as two instances) never get the same row", async () => {
    await clear();
    const due: number[] = [];
    // One row per session: a session's later revisions wait for its earlier ones (see "per-session revision order").
    for (let i = 0; i < 12; i++) {
      const id = await sessionWithRecord(1);
      due.push((await insertOutbox(pool, { sessionId: id, revision: 1, target: "webhook", nextAttemptAt: at(-1 - i) })).id);
    }
    const otherInstance = schema.open({ max: 4 }).pool;
    const allClaimed = barrier(6);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withTx(i % 2 === 0 ? pool : otherInstance, async (tx) => {
          const claimed = await claimDueOutbox(tx, { now: T0, limit: 2 });
          await allClaimed();
          return claimed.map((r) => r.id);
        }),
      ),
    );
    const flat = claims.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort((a, b) => a - b)).toEqual([...due].sort((a, b) => a - b));
  });
});
