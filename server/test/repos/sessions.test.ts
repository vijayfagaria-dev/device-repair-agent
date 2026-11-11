import { randomUUID } from "node:crypto";
import { Outcome } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSession, insertSession, lockSession, saveSession } from "../../src/db/repos/sessions.js";
import { withTx } from "../../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rsess"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("sessions repo", () => {
  it("insertSession creates a session with defaults, and returns null (changing nothing) for an existing id", async () => {
    const id = randomUUID();
    const created = await insertSession(pool, { id });
    expect(created).toMatchObject({
      id,
      status: "active",
      outcome: null,
      version: 0,
      currentRevision: 0,
      language: "en",
      activeCallId: null,
      openRequestId: null,
      reviewFlags: [],
    });
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.lastActivityAt).toBeInstanceOf(Date);
    expect(await insertSession(pool, { id, language: "hi" })).toBeNull();
    expect((await getSession(pool, id))?.language).toBe("en");
    expect((await insertSession(pool, { id: randomUUID(), language: "hi" }))?.language).toBe("hi");
  });

  it("getSession returns the row, or null for an unknown id", async () => {
    const id = randomUUID();
    await insertSession(pool, { id });
    expect((await getSession(pool, id))?.id).toBe(id);
    expect(await getSession(pool, randomUUID())).toBeNull();
  });

  it("lockSession returns the row inside a transaction (serialization is tested in tx.test.ts)", async () => {
    const id = randomUUID();
    await insertSession(pool, { id });
    expect(await withTx(pool, async (tx) => (await lockSession(tx, id))?.status)).toBe("active");
  });

  it("saveSession writes every mutable column, including JSON arrays and nulls", async () => {
    const id = randomUUID();
    const loaded = await insertSession(pool, { id });
    if (!loaded) throw new Error("not created");
    const at = new Date("2026-11-08T10:00:00.000Z");
    const changed = {
      ...loaded,
      status: "finalized" as const,
      outcome: Outcome.NEEDS_REVIEW,
      version: 7,
      currentRevision: 2,
      language: "hi",
      activeCallId: "c_1",
      openRequestId: "req_serial_1",
      reviewFlags: ["R-1", { rule: "R-2", field: "email" }],
      lastActivityAt: at,
    };
    expect(await saveSession(pool, changed)).toEqual(changed);
    expect(await getSession(pool, id)).toEqual(changed);
    const cleared = { ...changed, outcome: null, activeCallId: null, openRequestId: null, reviewFlags: [] };
    expect(await saveSession(pool, cleared)).toEqual(cleared);
  });

  it("saveSession returns null for an unknown id; the database rejects invalid values", async () => {
    const id = randomUUID();
    const loaded = await insertSession(pool, { id });
    if (!loaded) throw new Error("not created");
    expect(await saveSession(pool, { ...loaded, id: randomUUID() })).toBeNull();
    await expect(saveSession(pool, { ...loaded, status: "bogus" as never })).rejects.toMatchObject({ code: "23514" });
    await expect(saveSession(pool, { ...loaded, version: -1 })).rejects.toMatchObject({ code: "23514" });
  });
});
