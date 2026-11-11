import { FieldSource } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvent, listEvents, nextEventSeq } from "../../src/db/repos/events.js";
import { insertFieldCandidate, listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { lockSession } from "../../src/db/repos/sessions.js";
import { withTx } from "../../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("revt"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("events repo", () => {
  it("nextEventSeq starts at 1 and follows the last event; it is per session", async () => {
    const [a, b] = [await seedSession(pool), await seedSession(pool)];
    await withTx(pool, async (tx) => {
      await lockSession(tx, a);
      expect(await nextEventSeq(tx, a)).toBe(1);
      await appendEvent(tx, { sessionId: a, type: "x", channel: "system" });
      await appendEvent(tx, { sessionId: a, type: "y", channel: "system" });
      expect(await nextEventSeq(tx, a)).toBe(3);
      expect(await nextEventSeq(tx, b)).toBe(1);
    });
  });

  it("appendEvent stores type, channel and payload (default {}) at consecutive seqs", async () => {
    const id = await seedSession(pool);
    const [first, second] = await withTx(pool, async (tx) => {
      await lockSession(tx, id);
      return [
        await appendEvent(tx, { sessionId: id, type: "session.created", channel: "system" }),
        await appendEvent(tx, { sessionId: id, type: "chat.message", channel: "chat", payload: { text: "hi", n: [1, null] } }),
      ];
    });
    expect(first).toMatchObject({ sessionId: id, seq: 1, type: "session.created", channel: "system", payload: {} });
    expect(second).toMatchObject({ seq: 2, channel: "chat", payload: { text: "hi", n: [1, null] } });
    expect(second?.createdAt).toBeInstanceOf(Date);
  });

  it("appendEvent with a seq from nextEventSeq lets rows refer to the event before it exists (deferred FK)", async () => {
    const id = await seedSession(pool);
    await withTx(pool, async (tx) => {
      await lockSession(tx, id);
      const seq = await nextEventSeq(tx, id);
      await insertFieldCandidate(tx, { sessionId: id, eventSeq: seq, field: "email", source: FieldSource.CHAT, raw: "a@b.co", status: "valid" });
      expect((await appendEvent(tx, { sessionId: id, type: "field.collected", channel: "chat", seq })).seq).toBe(seq);
    });
    expect(await listFieldCandidates(pool, id)).toHaveLength(1);
  });

  it("a duplicate seq is rejected by UNIQUE(session_id, seq) (why appends need the session lock)", async () => {
    const id = await seedSession(pool);
    await expect(
      withTx(pool, async (tx) => {
        await appendEvent(tx, { sessionId: id, type: "x", channel: "system", seq: 1 });
        await appendEvent(tx, { sessionId: id, type: "y", channel: "system", seq: 1 });
      }),
    ).rejects.toMatchObject({ code: "23505", constraint: "events_session_seq_key" });
  });

  it("listEvents returns events in seq order, optionally after a seq", async () => {
    const id = await seedSession(pool);
    await withTx(pool, async (tx) => {
      await lockSession(tx, id);
      for (const type of ["a", "b", "c"]) await appendEvent(tx, { sessionId: id, type, channel: "system" });
    });
    expect((await listEvents(pool, id)).map((e) => [e.seq, e.type])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    expect((await listEvents(pool, id, { afterSeq: 2 })).map((e) => e.type)).toEqual(["c"]);
    expect(await listEvents(pool, await seedSession(pool))).toEqual([]);
  });
});
