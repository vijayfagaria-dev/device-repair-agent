import { Outcome } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLatestRecord, getRecord, insertRecord, listRecords } from "../../src/db/repos/records.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { HASH, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rrec"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const payload = (revision: number) => ({ revision, fields: { email: { value: "a@b.co", status: "valid" } }, conflicts: [] });

describe("records repo", () => {
  it("insertRecord stores a revision; the same revision twice is rejected", async () => {
    const id = await seedSession(pool);
    const rec = await insertRecord(pool, { sessionId: id, revision: 1, outcome: Outcome.PARTIAL, payload: payload(1), contentHash: HASH });
    expect(rec).toMatchObject({ sessionId: id, revision: 1, outcome: "partial", payload: payload(1), contentHash: HASH });
    expect(rec.createdAt).toBeInstanceOf(Date);
    await expect(
      insertRecord(pool, { sessionId: id, revision: 1, outcome: Outcome.COMPLETED, payload: payload(1), contentHash: HASH }),
    ).rejects.toMatchObject({ code: "23505", constraint: "records_session_revision_key" });
  });

  it("getRecord finds a revision; getLatestRecord the highest; listRecords all in order", async () => {
    const id = await seedSession(pool);
    expect(await getLatestRecord(pool, id)).toBeNull();
    expect(await listRecords(pool, id)).toEqual([]);
    for (const [revision, outcome] of [
      [1, Outcome.PARTIAL],
      [2, Outcome.COMPLETED],
    ] as const) {
      await insertRecord(pool, { sessionId: id, revision, outcome, payload: payload(revision), contentHash: String(revision).repeat(64) });
    }
    expect((await getRecord(pool, id, 1))?.outcome).toBe("partial");
    expect(await getRecord(pool, id, 3)).toBeNull();
    expect((await getLatestRecord(pool, id))?.revision).toBe(2);
    expect((await listRecords(pool, id)).map((r) => r.revision)).toEqual([1, 2]);
  });
});
