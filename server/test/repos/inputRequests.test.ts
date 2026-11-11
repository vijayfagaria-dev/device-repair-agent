import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getInputRequest,
  getOpenInputRequest,
  insertInputRequest,
  listInputRequests,
  saveInputRequest,
} from "../../src/db/repos/inputRequests.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rinp"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const SPEC = { kind: "text", label: "Serial number", required: true, pattern: "^[A-Z0-9]{8,}$" };

describe("input_requests repo", () => {
  it("insertInputRequest stores the card spec, queued by default", async () => {
    const id = await seedSession(pool);
    const req = await insertInputRequest(pool, { sessionId: id, id: "req_serial_1", field: "serialNumber", spec: SPEC });
    expect(req).toMatchObject({ sessionId: id, id: "req_serial_1", field: "serialNumber", spec: SPEC, status: "queued", attempts: 0 });
    expect(req.createdAt).toBeInstanceOf(Date);
    expect((await insertInputRequest(pool, { sessionId: id, id: "req_email_1", field: "email", spec: {}, status: "open" })).status).toBe("open");
  });

  it("getInputRequest finds a card by session and id", async () => {
    const id = await seedSession(pool);
    await insertInputRequest(pool, { sessionId: id, id: "req_a_1", field: "a", spec: SPEC });
    expect((await getInputRequest(pool, id, "req_a_1"))?.spec).toEqual(SPEC);
    expect(await getInputRequest(pool, id, "req_missing")).toBeNull();
    expect(await getInputRequest(pool, await seedSession(pool), "req_a_1")).toBeNull();
  });

  it("getOpenInputRequest returns the one open card; a second open card is rejected", async () => {
    const id = await seedSession(pool);
    expect(await getOpenInputRequest(pool, id)).toBeNull();
    await insertInputRequest(pool, { sessionId: id, id: "req_a_1", field: "a", spec: {} });
    await insertInputRequest(pool, { sessionId: id, id: "req_b_1", field: "b", spec: {}, status: "open" });
    expect((await getOpenInputRequest(pool, id))?.id).toBe("req_b_1");
    await expect(insertInputRequest(pool, { sessionId: id, id: "req_c_1", field: "c", spec: {}, status: "open" })).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("listInputRequests returns the session's cards in creation order", async () => {
    const id = await seedSession(pool);
    for (const n of [1, 2, 3]) await insertInputRequest(pool, { sessionId: id, id: `req_f_${n}`, field: "f", spec: { n } });
    expect((await listInputRequests(pool, id)).map((r) => r.id)).toEqual(["req_f_1", "req_f_2", "req_f_3"]);
  });

  it("saveInputRequest updates status, attempts and updated_at; null for an unknown card", async () => {
    const id = await seedSession(pool);
    const created = await insertInputRequest(pool, { sessionId: id, id: "req_a_1", field: "a", spec: {} });
    const saved = await saveInputRequest(pool, { sessionId: id, id: "req_a_1", status: "answered", attempts: 2 });
    expect(saved).toMatchObject({ status: "answered", attempts: 2, createdAt: created.createdAt });
    expect(saved?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(await saveInputRequest(pool, { sessionId: id, id: "req_nope", status: "answered", attempts: 1 })).toBeNull();
  });
});
