import { Role } from "@device-repair/shared/protocol";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertCall } from "../../src/db/repos/calls.js";
import { insertTranscriptLine, listTranscriptLines } from "../../src/db/repos/transcriptLines.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedEvent, seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rtl"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const AT = new Date("2026-11-08T11:00:00.000Z");

describe("transcript_lines repo", () => {
  it("insertTranscriptLine stores a final line (interrupted defaults to false)", async () => {
    const id = await seedSession(pool);
    const call = await insertCall(pool, { id: `c_${id}`, sessionId: id });
    const seq = await seedEvent(pool, id);
    const line = await insertTranscriptLine(pool, {
      id: `ta_${call.id}_1`,
      sessionId: id,
      callId: call.id,
      eventSeq: seq,
      role: Role.AGENT,
      text: "Hi, which device?",
      startedAt: AT,
    });
    expect(line).toEqual({
      id: `ta_${call.id}_1`,
      sessionId: id,
      callId: call.id,
      eventSeq: seq,
      role: "agent",
      text: "Hi, which device?",
      interrupted: false,
      startedAt: AT,
    });
    const cut = await insertTranscriptLine(pool, {
      id: `ta_${call.id}_2`,
      sessionId: id,
      callId: call.id,
      eventSeq: seq,
      role: Role.AGENT,
      text: "So the",
      interrupted: true,
      startedAt: AT,
    });
    expect(cut.interrupted).toBe(true);
  });

  it("listTranscriptLines returns the session's lines in event order", async () => {
    const id = await seedSession(pool);
    const call = await insertCall(pool, { id: `c_${id}`, sessionId: id });
    const first = await seedEvent(pool, id);
    const second = await seedEvent(pool, id);
    await insertTranscriptLine(pool, { id: `tu_${call.id}_1`, sessionId: id, callId: call.id, eventSeq: second, role: Role.USER, text: "a phone", startedAt: AT });
    await insertTranscriptLine(pool, { id: `ta_${call.id}_1`, sessionId: id, callId: call.id, eventSeq: first, role: Role.AGENT, text: "Which device?", startedAt: AT });
    expect((await listTranscriptLines(pool, id)).map((l) => l.text)).toEqual(["Which device?", "a phone"]);
    expect(await listTranscriptLines(pool, await seedSession(pool))).toEqual([]);
  });
});
