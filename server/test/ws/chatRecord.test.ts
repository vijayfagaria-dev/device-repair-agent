// Record visibility on /chat (P6-T03; protocol.md §3.3 `record`, §4 replay): the record card arrives with the
// finalization (≤ 1 s), in the right place in the thread, is the stored record exactly, is replayed on reconnect and
// after a restart, and a later revision has its own id so the page replaces its card instead of adding a second.
import { RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { ChatServerMessageSchema } from "@device-repair/shared/protocol/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { FIELDS } from "../../src/domain/fields.js";
import type { FinalizeReply } from "../../src/session/handlers/finalize.js";
import type { SessionServices } from "../../src/session/services.js";
import { VALID_VALUES } from "../domain/helpers.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";
import { seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("chatrecord", { max: 10 }));
  services = testServices(db);
  server = await startApp(db, { services });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

type Msg = { type: string; id?: string } & Record<string, unknown>;
const run = <R = unknown>(id: string, command: object) => services.processor.dispatch<R>(id, command as never);
const CHAT = new Set<string>(["serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"]);

const collect = async (id: string, fields: readonly (typeof RECORD_FIELD_IDS)[number][]) => {
  for (const field of fields) {
    await run(id, { type: "Test.Candidate", field, source: CHAT.has(field) ? "chat" : "call", raw: "x", normalized: VALID_VALUES[field], status: "valid" });
  }
};
const REQUIRED = RECORD_FIELD_IDS.filter((field) => FIELDS[field].required);

async function open(id: string, app = server): Promise<TestSocket & { all: () => Msg[] }> {
  const socket = connect(`${app.ws}/chat?sessionId=${id}`);
  await socket.opened;
  await until(() => (socket.messages as Msg[]).some((m) => m.type === "syncDone"), "syncDone");
  return Object.assign(socket, { all: () => socket.messages as Msg[] });
}
async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const records = (messages: Msg[]) => messages.filter((m) => m.type === "record");

describe("the record on the chat socket", () => {
  it("arrives live within 1 s of the finalization, as the stored record, between the closed cards and the closing message", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType", "deviceModel"]);
    await run(id, { type: "Test.OpenCard", requestId: "req_problemDescription_1", field: "problemDescription" });
    const chat = await open(id);
    const sinceSync = chat.all().length;

    const started = Date.now();
    const { reply } = await run<FinalizeReply>(id, { type: "Finalize", trigger: "optOutConfirmed" });
    expect(reply).toMatchObject({ finalized: true, revision: 1, outcome: "optedOut" });
    await until(() => records(chat.all()).length > 0, "the record message", 1_000);
    expect(Date.now() - started).toBeLessThan(1_000);

    const [stored] = await listRecords(db.pool, id);
    const live = chat.all().slice(sinceSync);
    const message = records(live)[0];
    expect(message).toEqual({ type: "record", id: "rec_1", record: stored?.payload });
    expect(ChatServerMessageSchema.safeParse(message).success).toBe(true);
    expectSanitizedRecord(message?.record, { secrets: FAKE_SECRET_VALUES });

    // The card the finalization closed (an opt-out closes every card; a partial session keeps its card), then the record,
    // then the closing message; the state last.
    expect(live.map((m) => m.type)).toEqual(["inputCancel", "record", "message", "sessionState"]);
    expect(live.at(-1)).toMatchObject({ status: "finalized", outcome: "optedOut", revision: 1 });
    chat.ws.close();
  });

  it("is replayed to a returning page and a second tab exactly as it was sent live, and never twice", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType"]);
    const first = await open(id);
    await run(id, { type: "Finalize", trigger: "testFinalize" });
    await until(() => records(first.all()).length > 0, "the live record");

    const second = await open(id); // a second tab, or a reload
    expect(records(second.all())).toEqual(records(first.all()));
    // Replay puts the record after the history and before sessionState and syncDone (§4 step 3).
    expect(second.all().map((m) => m.type).slice(-3)).toEqual(["record", "sessionState", "syncDone"]);
    first.ws.close();
    second.ws.close();
  });

  it("a later revision has its own id and is the only record a returning page is sent; history stays in the records endpoint", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType", "deviceModel"]);
    const chat = await open(id);
    await run(id, { type: "Finalize", trigger: "testFinalize" });
    await until(() => records(chat.all()).length === 1, "revision 1");

    // The session becomes active again (what the reopen flow, P7-T05, does) and the claim is completed.
    await db.pool.query("UPDATE sessions SET status = 'active' WHERE id = $1", [id]);
    await collect(id, REQUIRED);
    await run(id, { type: "Test.Candidate", field: "submitConfirmation", source: "chat", raw: true, normalized: true, status: "valid" });
    const { reply } = await run<FinalizeReply>(id, { type: "Finalize", trigger: "confirmSubmit" });
    expect(reply).toMatchObject({ finalized: true, revision: 2, outcome: "completed" });
    await until(() => records(chat.all()).length === 2, "revision 2");

    // Distinct ids: the page's reducer replaces the card it shows (web/test/recordCard.test.ts); the server never
    // re-sends rev 1 as part of rev 2.
    expect(records(chat.all()).map((m) => m.id)).toEqual(["rec_1", "rec_2"]);
    expect(records(chat.all())[1]?.record).toMatchObject({ revision: 2, outcome: "completed", previousRevision: { revision: 1, outcome: "partial" } });

    const reload = await open(id);
    expect(records(reload.all()).map((m) => m.id)).toEqual(["rec_2"]);
    expect(((await server.app.inject({ method: "GET", url: `/api/sessions/${id}/records` })).json() as { records: { revision: number }[] }).records.map((r) => r.revision)).toEqual([1, 2]);
    chat.ws.close();
    reload.ws.close();
  });

  it("a reconnect alone does not reopen a finalized session: it replays the record and the card the partial session kept", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType"]);
    await run(id, { type: "Test.OpenCard", requestId: "req_deviceModel_1", field: "deviceModel" });
    await run(id, { type: "Finalize", trigger: "testFinalize" });
    for (let i = 0; i < 3; i++) {
      const chat = await open(id);
      expect(chat.all().filter((m) => m.type === "inputRequest")).toMatchObject([{ id: "req_deviceModel_1" }]); // kept open (partial)
      expect(records(chat.all()).map((m) => m.id)).toEqual(["rec_1"]);
      expect(chat.all().find((m) => m.type === "sessionState")).toMatchObject({ status: "finalized", outcome: "partial" });
      chat.ws.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100)); // the connect-time reconcile has run
    expect((await getSession(db.pool, id))?.status).toBe("finalized");
    expect((await listEvents(db.pool, id)).map((e) => e.type)).not.toContain("session.reopened");
    expect(await listRecords(db.pool, id)).toHaveLength(1);
  });

  it("survives a server restart: a new process (empty hub) replays the same record", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType"]);
    await run(id, { type: "Finalize", trigger: "testFinalize" });
    const before = await open(id);
    const restarted = await startApp(db, { services: testServices(db) });
    try {
      const after = await open(id, restarted);
      expect(records(after.all())).toEqual(records(before.all()));
      expect(records(after.all())).toHaveLength(1);
      after.ws.close();
    } finally {
      before.ws.close();
      await restarted.close();
    }
  });
});
