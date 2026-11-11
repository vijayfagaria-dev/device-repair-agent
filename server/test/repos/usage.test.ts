import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUsage, listUsage } from "../../src/db/repos/usage.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("ruse"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("usage repo", () => {
  it("insertUsage stores units and cost as numbers (cost defaults to 0, exact to 8 decimals)", async () => {
    const id = await seedSession(pool);
    const at = new Date("2026-11-08T07:00:00.000Z");
    const entry = await insertUsage(pool, { sessionId: id, provider: "groq", kind: "llm.prompt", units: 1234, unit: "token", costUsd: 0.00012345, at });
    expect(entry).toMatchObject({ sessionId: id, provider: "groq", kind: "llm.prompt", units: 1234, unit: "token", costUsd: 0.00012345, at });
    expect(typeof entry.id).toBe("number");
    const free = await insertUsage(pool, { sessionId: id, provider: "deepgram", kind: "stt", units: 1.5, unit: "minute" });
    expect(free).toMatchObject({ units: 1.5, costUsd: 0 });
    expect(free.at).toBeInstanceOf(Date);
  });

  it("insertUsage rejects negative or non-finite amounts before querying", async () => {
    const id = await seedSession(pool);
    for (const bad of [{ units: -1 }, { units: Number.NaN }, { units: 1, costUsd: -0.01 }, { units: Number.POSITIVE_INFINITY }]) {
      await expect(insertUsage(pool, { sessionId: id, provider: "p", kind: "k", unit: "u", ...bad })).rejects.toBeInstanceOf(RangeError);
    }
    expect(await listUsage(pool, id)).toEqual([]);
  });

  it("listUsage returns the session's entries in time order", async () => {
    const id = await seedSession(pool);
    await insertUsage(pool, { sessionId: id, provider: "b", kind: "k", units: 2, unit: "u", at: new Date("2026-11-08T07:02:00Z") });
    await insertUsage(pool, { sessionId: id, provider: "a", kind: "k", units: 1, unit: "u", at: new Date("2026-11-08T07:01:00Z") });
    expect((await listUsage(pool, id)).map((u) => u.provider)).toEqual(["a", "b"]);
    expect(await listUsage(pool, await seedSession(pool))).toEqual([]);
  });
});
