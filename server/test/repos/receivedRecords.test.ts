import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listReceivedRecords, upsertReceivedRecord } from "../../src/db/repos/receivedRecords.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rrcv"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("received_records repo", () => {
  it("upsertReceivedRecord stores a key once and counts repeats, keeping the first payload", async () => {
    const first = await upsertReceivedRecord(pool, { idempotencyKey: "s1:1", payload: { revision: 1, n: "first" } });
    expect(first).toMatchObject({ idempotencyKey: "s1:1", payload: { revision: 1, n: "first" }, timesReceived: 1 });
    await upsertReceivedRecord(pool, { idempotencyKey: "s1:1", payload: { revision: 1, n: "second" } });
    const third = await upsertReceivedRecord(pool, { idempotencyKey: "s1:1", payload: { revision: 1, n: "third" } });
    expect(third).toMatchObject({ timesReceived: 3, payload: { revision: 1, n: "first" }, firstReceivedAt: first.firstReceivedAt });
    expect(third.lastReceivedAt.getTime()).toBeGreaterThanOrEqual(first.lastReceivedAt.getTime());
  });

  it("concurrent identical deliveries still give one row with the right count", async () => {
    await Promise.all(Array.from({ length: 5 }, () => upsertReceivedRecord(pool, { idempotencyKey: "s2:1", payload: [1, 2] })));
    const row = (await listReceivedRecords(pool)).find((r) => r.idempotencyKey === "s2:1");
    expect(row).toMatchObject({ timesReceived: 5, payload: [1, 2] });
  });

  it("listReceivedRecords returns every stored key in arrival order", async () => {
    await upsertReceivedRecord(pool, { idempotencyKey: "s3:1", payload: {} });
    expect((await listReceivedRecords(pool)).map((r) => r.idempotencyKey)).toEqual(["s1:1", "s2:1", "s3:1"]);
  });
});
