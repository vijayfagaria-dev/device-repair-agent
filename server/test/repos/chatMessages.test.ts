import { Role } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertChatMessage, listChatMessages } from "../../src/db/repos/chatMessages.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedEvent, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rchat"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("chat_messages repo", () => {
  it("insertChatMessage stores the message, with an optional request id", async () => {
    const id = await seedSession(pool);
    const seq = await seedEvent(pool, id);
    const msg = await insertChatMessage(pool, { id: `m_${id}_1`, sessionId: id, eventSeq: seq, role: Role.AGENT, text: "Hello" });
    expect(msg).toMatchObject({ id: `m_${id}_1`, sessionId: id, eventSeq: seq, role: "agent", text: "Hello", requestId: null });
    expect(msg.createdAt).toBeInstanceOf(Date);
    const reply = await insertChatMessage(pool, {
      id: `m_${id}_2`,
      sessionId: id,
      eventSeq: seq,
      role: Role.USER,
      text: "AB12",
      requestId: "req_serial_1",
    });
    expect(reply.requestId).toBe("req_serial_1");
    await expect(insertChatMessage(pool, { id: `m_${id}_1`, sessionId: id, eventSeq: seq, role: Role.USER, text: "dup" })).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("listChatMessages returns the session's messages in event order", async () => {
    const id = await seedSession(pool);
    const first = await seedEvent(pool, id);
    const second = await seedEvent(pool, id);
    // Inserted out of order: the list follows event_seq, not insertion.
    await insertChatMessage(pool, { id: `m_${id}_b`, sessionId: id, eventSeq: second, role: Role.USER, text: "second" });
    await insertChatMessage(pool, { id: `m_${id}_a`, sessionId: id, eventSeq: first, role: Role.AGENT, text: "first" });
    expect((await listChatMessages(pool, id)).map((m) => m.text)).toEqual(["first", "second"]);
    expect(await listChatMessages(pool, await seedSession(pool))).toEqual([]);
  });
});
