import { FieldSource } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFieldCandidate, listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedEvent, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rfc"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("field_candidates repo", () => {
  it("insertFieldCandidate stores any JSON raw value, with defaults", async () => {
    const id = await seedSession(pool);
    const seq = await seedEvent(pool, id);
    const minimal = await insertFieldCandidate(pool, {
      sessionId: id,
      eventSeq: seq,
      field: "serialNumber",
      source: FieldSource.CALL,
      raw: "ab 12",
      status: "unverified",
    });
    expect(minimal).toMatchObject({
      sessionId: id,
      eventSeq: seq,
      field: "serialNumber",
      source: "call",
      raw: "ab 12",
      normalized: null,
      status: "unverified",
      error: null,
      userConfirmed: false,
      evidence: null,
    });
    expect(typeof minimal.id).toBe("number");
    expect(minimal.collectedAt).toBeInstanceOf(Date);

    const at = new Date("2026-11-08T09:30:00.000Z");
    const full = await insertFieldCandidate(pool, {
      sessionId: id,
      eventSeq: seq,
      field: "photos",
      source: FieldSource.CHAT,
      raw: ["file:a", "file:b"],
      normalized: { urls: ["file:a", "file:b"], count: 2 },
      status: "invalid",
      error: "too_many",
      userConfirmed: true,
      collectedAt: at,
      evidence: "user said two",
    });
    expect(full).toMatchObject({
      raw: ["file:a", "file:b"],
      normalized: { urls: ["file:a", "file:b"], count: 2 },
      error: "too_many",
      userConfirmed: true,
      collectedAt: at,
      evidence: "user said two",
    });
    expect(full.id).toBeGreaterThan(minimal.id);
  });

  it("listFieldCandidates returns all candidates, or one field's, in insertion order", async () => {
    const id = await seedSession(pool);
    const seq = await seedEvent(pool, id);
    for (const [field, raw] of [
      ["email", "a@b.co"],
      ["phone", "+911234567890"],
      ["email", "c@d.co"],
    ] as const) {
      await insertFieldCandidate(pool, { sessionId: id, eventSeq: seq, field, source: FieldSource.CHAT, raw, status: "valid" });
    }
    expect((await listFieldCandidates(pool, id)).map((c) => c.raw)).toEqual(["a@b.co", "+911234567890", "c@d.co"]);
    expect((await listFieldCandidates(pool, id, "email")).map((c) => c.raw)).toEqual(["a@b.co", "c@d.co"]);
    expect(await listFieldCandidates(pool, id, "nothing")).toEqual([]);
  });

  it("a candidate pointing at a missing event is rejected (outside a transaction the deferred FK checks at once)", async () => {
    const id = await seedSession(pool);
    await expect(
      insertFieldCandidate(pool, { sessionId: id, eventSeq: 42, field: "email", source: FieldSource.CHAT, raw: "x", status: "valid" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
