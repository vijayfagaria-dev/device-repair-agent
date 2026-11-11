import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertCall } from "../../src/db/repos/calls.js";
import { listTurnMetrics, upsertTurnMetric } from "../../src/db/repos/turnMetrics.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rturn"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

async function sessionWithCall(): Promise<{ sessionId: string; callId: string }> {
  const sessionId = await seedSession(pool);
  const call = await insertCall(pool, { id: `c_${sessionId}`, sessionId });
  return { sessionId, callId: call.id };
}

describe("turn_metrics repo", () => {
  it("upsertTurnMetric inserts a turn, then merges later stages without erasing earlier ones", async () => {
    const ids = await sessionWithCall();
    const userEndAt = new Date("2026-11-08T10:00:00.000Z");
    const first = await upsertTurnMetric(pool, { turnId: "ta_1", ...ids, userEndAt, sttMs: 120, llmTtftMs: 300 });
    expect(first).toEqual({
      turnId: "ta_1",
      ...ids,
      userEndAt,
      firstAudioAt: null,
      serverMs: null,
      clientMs: null,
      sttMs: 120,
      llmTtftMs: 300,
      ttsTtfbMs: null,
    });
    const merged = await upsertTurnMetric(pool, { turnId: "ta_1", ...ids, clientMs: 950, serverMs: 800 });
    expect(merged).toMatchObject({ userEndAt, sttMs: 120, llmTtftMs: 300, clientMs: 950, serverMs: 800 });
  });

  it("upsertTurnMetric refuses (null, nothing changed) to write into another session's turn", async () => {
    const owner = await sessionWithCall();
    const other = await sessionWithCall();
    await upsertTurnMetric(pool, { turnId: "ta_owned", ...owner, clientMs: 500 });
    expect(await upsertTurnMetric(pool, { turnId: "ta_owned", ...other, clientMs: 1 })).toBeNull();
    expect((await listTurnMetrics(pool, owner.sessionId))[0]?.clientMs).toBe(500);
    expect(await listTurnMetrics(pool, other.sessionId)).toEqual([]);
  });

  it("listTurnMetrics returns the session's turns in time order", async () => {
    const ids = await sessionWithCall();
    await upsertTurnMetric(pool, { turnId: "ta_b", ...ids, userEndAt: new Date("2026-11-08T10:00:02Z") });
    await upsertTurnMetric(pool, { turnId: "ta_a", ...ids, userEndAt: new Date("2026-11-08T10:00:01Z") });
    await upsertTurnMetric(pool, { turnId: "ta_c", ...ids });
    expect((await listTurnMetrics(pool, ids.sessionId)).map((t) => t.turnId)).toEqual(["ta_a", "ta_b", "ta_c"]);
  });
});
