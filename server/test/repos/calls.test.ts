import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endCall, getActiveCall, getCall, insertCall } from "../../src/db/repos/calls.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rcall"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

describe("calls repo", () => {
  it("insertCall starts a call; a second active call in the session is rejected", async () => {
    const id = await seedSession(pool);
    const call = await insertCall(pool, { id: `c_${id}_1`, sessionId: id });
    expect(call).toMatchObject({ id: `c_${id}_1`, sessionId: id, endedAt: null, endReason: null });
    expect(call.startedAt).toBeInstanceOf(Date);
    await expect(insertCall(pool, { id: `c_${id}_2`, sessionId: id })).rejects.toMatchObject({ code: "23505" });
    const at = new Date("2026-11-08T08:00:00.000Z");
    expect((await insertCall(pool, { id: `c_${id}_x`, sessionId: await seedSession(pool), startedAt: at })).startedAt).toEqual(at);
  });

  it("getCall finds a call by id", async () => {
    const id = await seedSession(pool);
    await insertCall(pool, { id: `c_${id}_1`, sessionId: id });
    expect((await getCall(pool, `c_${id}_1`))?.sessionId).toBe(id);
    expect(await getCall(pool, "c_missing")).toBeNull();
  });

  it("getActiveCall returns the session's call until it ends", async () => {
    const id = await seedSession(pool);
    expect(await getActiveCall(pool, id)).toBeNull();
    await insertCall(pool, { id: `c_${id}_1`, sessionId: id });
    expect((await getActiveCall(pool, id))?.id).toBe(`c_${id}_1`);
    await endCall(pool, { id: `c_${id}_1`, reason: "hangup" });
    expect(await getActiveCall(pool, id)).toBeNull();
  });

  it("endCall ends an active call once (the first end wins) and allows a new call", async () => {
    const id = await seedSession(pool);
    const started = await insertCall(pool, { id: `c_${id}_1`, sessionId: id });
    const endedAt = new Date(started.startedAt.getTime() + 90_000);
    expect(await endCall(pool, { id: `c_${id}_1`, reason: "hangup", endedAt })).toMatchObject({ endedAt, endReason: "hangup" });
    expect(await endCall(pool, { id: `c_${id}_1`, reason: "server_restart" })).toBeNull();
    expect((await getCall(pool, `c_${id}_1`))?.endReason).toBe("hangup");
    expect(await endCall(pool, { id: "c_missing", reason: "hangup" })).toBeNull();
    expect((await insertCall(pool, { id: `c_${id}_2`, sessionId: id })).endedAt).toBeNull();
  });
});
