import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { claimDueTimers, deleteTimer, earliestTimerDueAt, listTimers, type Timer, upsertTimer } from "../../src/db/repos/timers.js";
import { withTx } from "../../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { barrier, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: Database;
  ({ schema, db } = await createMigratedSchema("rtim", { max: 8 }));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const T0 = new Date("2026-11-08T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const key = (t: Timer) => `${t.sessionId}/${t.kind}`;

// Tests in this file run in order and share the timers table; each starts from an empty table.
async function clear(): Promise<void> {
  await pool.query("DELETE FROM timers");
}

describe("timers repo", () => {
  it("upsertTimer sets a timer and moves it on a second call (one per kind per session)", async () => {
    await clear();
    const id = await seedSession(pool);
    expect(await upsertTimer(pool, { sessionId: id, kind: "idle", dueAt: at(60) })).toEqual({ sessionId: id, kind: "idle", dueAt: at(60) });
    expect(await upsertTimer(pool, { sessionId: id, kind: "idle", dueAt: at(120) })).toEqual({ sessionId: id, kind: "idle", dueAt: at(120) });
    expect(await listTimers(pool, id)).toEqual([{ sessionId: id, kind: "idle", dueAt: at(120) }]);
  });

  it("listTimers returns the session's timers, earliest first", async () => {
    await clear();
    const id = await seedSession(pool);
    await upsertTimer(pool, { sessionId: id, kind: "sessionExpiry", dueAt: at(600) });
    await upsertTimer(pool, { sessionId: id, kind: "idle", dueAt: at(60) });
    expect((await listTimers(pool, id)).map((t) => t.kind)).toEqual(["idle", "sessionExpiry"]);
    expect(await listTimers(pool, await seedSession(pool))).toEqual([]);
  });

  it("deleteTimer removes a timer and reports whether one existed", async () => {
    await clear();
    const id = await seedSession(pool);
    await upsertTimer(pool, { sessionId: id, kind: "idle", dueAt: at(60) });
    expect(await deleteTimer(pool, id, "idle")).toBe(true);
    expect(await deleteTimer(pool, id, "idle")).toBe(false);
    expect(await listTimers(pool, id)).toEqual([]);
  });

  it("earliestTimerDueAt is the minimum across sessions, or null with no timers", async () => {
    await clear();
    expect(await earliestTimerDueAt(pool)).toBeNull();
    await upsertTimer(pool, { sessionId: await seedSession(pool), kind: "idle", dueAt: at(300) });
    await upsertTimer(pool, { sessionId: await seedSession(pool), kind: "noCallStart", dueAt: at(30) });
    expect(await earliestTimerDueAt(pool)).toEqual(at(30));
  });

  it("claimDueTimers returns only due timers, earliest first, up to the limit", async () => {
    await clear();
    const id = await seedSession(pool);
    await upsertTimer(pool, { sessionId: id, kind: "idle", dueAt: at(-10) });
    await upsertTimer(pool, { sessionId: id, kind: "noCallStart", dueAt: at(-20) });
    await upsertTimer(pool, { sessionId: id, kind: "sessionExpiry", dueAt: at(10) });
    const claimed = await withTx(pool, (tx) => claimDueTimers(tx, { now: T0, limit: 10 }));
    expect(claimed.map((t) => t.kind)).toEqual(["noCallStart", "idle"]);
    expect((await withTx(pool, (tx) => claimDueTimers(tx, { now: T0, limit: 1 }))).map((t) => t.kind)).toEqual(["noCallStart"]);
    await expect(withTx(pool, (tx) => claimDueTimers(tx, { now: T0, limit: 0 }))).rejects.toBeInstanceOf(RangeError);
  });

  it("SKIP LOCKED: concurrent claimers (two pools, as two instances) never get the same timer", async () => {
    await clear();
    const due: string[] = [];
    for (let i = 0; i < 12; i++) {
      const timer = await upsertTimer(pool, { sessionId: await seedSession(pool), kind: "idle", dueAt: at(-i) });
      due.push(key(timer));
    }
    await upsertTimer(pool, { sessionId: await seedSession(pool), kind: "idle", dueAt: at(5) }); // not due
    const otherInstance = schema.open({ max: 4 }).pool;
    const allClaimed = barrier(6);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withTx(i % 2 === 0 ? pool : otherInstance, async (tx) => {
          const claimed = await claimDueTimers(tx, { now: T0, limit: 3 });
          await allClaimed(); // every claimer holds its claim until all six have claimed
          return claimed.map(key);
        }),
      ),
    );
    const flat = claims.flat();
    expect(new Set(flat).size).toBe(flat.length); // no timer handed to two claimers
    expect([...flat].sort()).toEqual([...due].sort()); // and every due timer was claimed once
  });

  it("a claim lasts until its transaction ends; then the row is claimable again", async () => {
    await clear();
    await upsertTimer(pool, { sessionId: await seedSession(pool), kind: "idle", dueAt: at(-1) });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const claimedFirst = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const first = withTx(pool, async (tx) => {
      const claimed = await claimDueTimers(tx, { now: T0, limit: 5 });
      holding();
      await hold;
      return claimed.length;
    });
    await claimedFirst;
    expect(await withTx(pool, (tx) => claimDueTimers(tx, { now: T0, limit: 5 }))).toEqual([]);
    release();
    expect(await first).toBe(1);
    expect(await withTx(pool, (tx) => claimDueTimers(tx, { now: T0, limit: 5 }))).toHaveLength(1);
  });
});
