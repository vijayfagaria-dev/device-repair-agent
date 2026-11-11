// withTx and lockSession against a real Postgres: commit, rollback, client release, timeouts, broken connections,
// and per-session serialization across concurrent transactions.
import { Role } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { Database } from "../src/db/pool.js";
import { insertChatMessage } from "../src/db/repos/chatMessages.js";
import { appendEvent, listEvents, nextEventSeq } from "../src/db/repos/events.js";
import { getSession, lockSession } from "../src/db/repos/sessions.js";
import { TX_STATEMENT_TIMEOUT_MS, type Tx, withTx } from "../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "./helpers/db.js";
import { seedSession, sleep } from "./helpers/seed.js";

let schema: TestSchema;
let db: Database;
let pool: pg.Pool;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("tx"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

async function count(table: string, sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE session_id = $1`, [sessionId]);
  return rows[0]?.n ?? -1;
}

/** Every client is back in the pool and nobody is waiting for one. */
function expectPoolSettled(): void {
  expect(pool.waitingCount).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
}

describe("withTx", () => {
  it("commits and returns the callback's value", async () => {
    const id = await seedSession(pool);
    const seq = await withTx(pool, async (tx) => {
      await lockSession(tx, id);
      return (await appendEvent(tx, { sessionId: id, type: "a", channel: "system" })).seq;
    });
    expect(seq).toBe(1);
    expect(await count("events", id)).toBe(1);
    expectPoolSettled();
  });

  it("throwing inside withTx leaves zero rows and releases the client (idle count restored)", async () => {
    await pool.query("SELECT 1"); // warm: one idle client
    const idleBefore = pool.idleCount;
    const totalBefore = pool.totalCount;
    const id = "6f1c1f9e-4d55-4a43-9a51-0a8f6b1c2d3e";
    const boom = new Error("boom");
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("INSERT INTO sessions (id) VALUES ($1)", [id]);
        await appendEvent(tx, { sessionId: id, type: "a", channel: "system" });
        await tx.query("INSERT INTO records (session_id, revision, outcome, payload, content_hash) VALUES ($1, 1, 'partial', '{}', $2)", [
          id,
          "f".repeat(64),
        ]);
        expect(pool.idleCount).toBe(idleBefore - 1); // the transaction holds the client
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await getSession(pool, id)).toBeNull();
    expect(await count("events", id)).toBe(0);
    expect(await count("records", id)).toBe(0);
    expect(pool.idleCount).toBe(idleBefore);
    expect(pool.totalCount).toBe(totalBefore);
    expectPoolSettled();
  });

  it("does not leak clients: 40 concurrent failing transactions on a pool of 5, then the pool still works", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        withTx(pool, async (tx) => {
          await tx.query("SELECT 1");
          if (i % 2 === 0) throw new Error(`fail ${i}`);
          await tx.query("SELECT 1/0"); // a SQL error fails the other half
        }),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(pool.totalCount).toBeLessThanOrEqual(5);
    expectPoolSettled();
    expect(await withTx(pool, async (tx) => (await tx.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok)).toBe(1);
  });

  it("rolls back when COMMIT fails (a deferred foreign key) and releases the client", async () => {
    const id = await seedSession(pool);
    await expect(
      withTx(pool, (tx) => insertChatMessage(tx, { id: "m_orphan", sessionId: id, eventSeq: 99, role: Role.USER, text: "hi" })),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await count("chat_messages", id)).toBe(0);
    expectPoolSettled();
  });

  it("sets a transaction-local statement_timeout that ends with the transaction", async () => {
    const single = schema.open({ max: 1 }).pool; // one client, so the check after the transaction reuses it
    const inside = await withTx(single, async (tx) => (await tx.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]?.t);
    expect(inside).toBe(`${TX_STATEMENT_TIMEOUT_MS / 1000}s`);
    const after = (await single.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]?.t;
    expect(after).not.toBe(inside);
  });

  it("cancels a statement that exceeds the timeout (57014) and returns the client", async () => {
    const started = Date.now();
    await expect(withTx(pool, (tx) => tx.query("SELECT pg_sleep(5)"), { statementTimeoutMs: 200 })).rejects.toMatchObject({ code: "57014" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expectPoolSettled();
  });

  it("rejects an invalid timeout before taking a client", async () => {
    const before = db.stats.acquired;
    for (const statementTimeoutMs of [0, -1, 1.5, TX_STATEMENT_TIMEOUT_MS + 1]) {
      await expect(withTx(pool, async () => 1, { statementTimeoutMs })).rejects.toBeInstanceOf(RangeError);
    }
    expect(db.stats.acquired).toBe(before);
  });

  it("destroys the client when the connection dies mid-transaction; the pool keeps working", async () => {
    const id = await seedSession(pool);
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("INSERT INTO usage (session_id, provider, kind, units, unit) VALUES ($1, 'x', 'y', 1, 'z')", [id]);
        const pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await pool.query("SELECT pg_terminate_backend($1)", [pid]); // from another connection
        await sleep(200);
        await tx.query("SELECT 1");
      }),
    ).rejects.toThrow();
    expect(await count("usage", id)).toBe(0);
    expectPoolSettled();
    expect((await pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok).toBe(1);
  });

  it("the Tx handle is unusable after the transaction ends", async () => {
    let escaped: Tx | undefined;
    await withTx(pool, async (tx) => {
      escaped = tx;
    });
    await expect(escaped?.query("SELECT 1")).rejects.toThrow(/already finished/);
  });

  it("transaction-only functions take a Tx, which the pool is not (compile-time check)", () => {
    expectTypeOf(lockSession).parameter(0).toEqualTypeOf<Tx>();
    expectTypeOf(nextEventSeq).parameter(0).toEqualTypeOf<Tx>();
    expectTypeOf(appendEvent).parameter(0).toEqualTypeOf<Tx>();
    expectTypeOf<pg.Pool>().not.toExtend<Tx>();
    expectTypeOf<pg.PoolClient>().not.toExtend<Tx>();
  });
});

describe("lockSession", () => {
  it("returns the locked session, or null for an unknown id", async () => {
    const id = await seedSession(pool);
    await withTx(pool, async (tx) => {
      expect((await lockSession(tx, id))?.id).toBe(id);
      expect(await lockSession(tx, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });

  it("two concurrent withTx calls that lock the same session run one after the other", async () => {
    const id = await seedSession(pool);
    const log: string[] = [];
    let signal!: () => void;
    const aHasLock = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const a = withTx(pool, async (tx) => {
      await lockSession(tx, id);
      log.push("A locked");
      signal();
      await sleep(300);
      await appendEvent(tx, { sessionId: id, type: "from.a", channel: "system" });
      log.push("A done");
    });
    await aHasLock;
    const startedB = Date.now();
    const b = withTx(pool, async (tx) => {
      await lockSession(tx, id);
      log.push("B locked");
      // B sees A's committed write: it only got the lock after A's COMMIT.
      return { waitedMs: Date.now() - startedB, events: (await listEvents(tx, id)).map((e) => e.type) };
    });
    const [, fromB] = await Promise.all([a, b]);
    expect(log).toEqual(["A locked", "A done", "B locked"]);
    expect(fromB.events).toEqual(["from.a"]);
    expect(fromB.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it("locks on different sessions don't block each other", async () => {
    const [s1, s2] = [await seedSession(pool), await seedSession(pool)];
    const log: string[] = [];
    let signal!: () => void;
    const aHasLock = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const a = withTx(pool, async (tx) => {
      await lockSession(tx, s1);
      signal();
      await sleep(300);
      log.push("A done");
    });
    await aHasLock;
    const b = withTx(pool, async (tx) => {
      await lockSession(tx, s2);
      log.push("B done");
    });
    await Promise.all([a, b]);
    expect(log).toEqual(["B done", "A done"]);
  });

  it("serializes event appends: 50 concurrent locked appends get seq 1…50 with no failures", async () => {
    const id = await seedSession(pool);
    const seqs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withTx(pool, async (tx) => {
          await lockSession(tx, id);
          return (await appendEvent(tx, { sessionId: id, type: `e${i}`, channel: "system" })).seq;
        }),
      ),
    );
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await listEvents(pool, id)).map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expectPoolSettled();
  });
});
