// Restart chaos tests (P8-T03, MH5 "survives a restart"): the real server process kills itself with SIGKILL at a named
// failpoint, then a new process starts on the same database. After each: the data is there, the next card is open
// where it should be, exactly one revision exists per finalization, and the receiver holds exactly one stored record
// (a redelivery only raises its counter). Failpoints, not sleeps: the process dies at the point, the test waits for it.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listCalls } from "../../src/db/repos/calls.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { listOutbox } from "../../src/db/repos/outbox.js";
import { listReceivedRecords } from "../../src/db/repos/receivedRecords.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import type { SessionServices } from "../../src/session/services.js";
import { answer, ANSWERS, openCard, sessionAtField } from "../helpers/chatFlow.js";
import { connect } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { testServices } from "../helpers/session.js";
import { CHAOS_ORIGIN, exitsWithin, finalizeRequest, type Spawned, spawnServer, until } from "./harness.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices; // seeds state in-process, through the same handlers the server runs

const spawned: Spawned[] = [];
const server = (options?: Parameters<typeof spawnServer>[1]) => {
  const s = spawnServer(schema.url, options);
  spawned.push(s);
  return s;
};

// A schema of its own per test: a row one test leaves behind (an undelivered record, say) must never be picked up, and
// trip a failpoint, in the next test's server.
beforeEach(async () => {
  ({ schema, db } = await createMigratedSchema("chaos", { max: 8 }));
  services = testServices(db, { planner: true });
});
afterEach(async () => {
  for (const s of spawned.splice(0)) {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGKILL");
    await s.exit;
  }
  await schema.drop();
});

const received = async (id: string) => (await listReceivedRecords(db.pool)).filter((r) => r.idempotencyKey.startsWith(id));
const revisions = async (id: string) => (await listRecords(db.pool, id)).map((r) => r.revision);
const eventTypes = async (id: string) => (await listEvents(db.pool, id)).map((e) => e.type);
const log = (s: Spawned, msg: string) => s.logs().find((l) => l.msg === msg);

/** Restarts: a new process on the same database; resolves with its address once it listens (recovery has run). */
async function restart(): Promise<{ s: Spawned; address: string }> {
  const s = server();
  return { s, address: await s.listening };
}

describe("kill -9 at a failpoint, then restart", () => {
  it("1. right after a chat input commit: the answer is kept, and the restart opens the next card", async () => {
    const id = await sessionAtField(db, services, "serialNumber");
    const card = await openCard(db, id);
    const first = server({ failpoints: "commit.after.SubmitChatInput" });
    const address = await first.listening;
    const chat = connect(`${address.replace(/^http/, "ws")}/chat?sessionId=${id}`, { origin: CHAOS_ORIGIN });
    await chat.opened;
    await until(async () => (chat.messages as { type: string }[]).some((m) => m.type === "syncDone"), "the replay");
    chat.ws.send(JSON.stringify({ type: "inputResponse", requestId: card?.id, field: "serialNumber", value: ANSWERS.serialNumber }));
    expect(await exitsWithin(first)).toEqual({ code: null, signal: "SIGKILL" });

    // The commit survived; its reaction (the planner opening the next card) never ran.
    const candidates = await listFieldCandidates(db.pool, id, "serialNumber");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ status: "valid", source: "chat" });
    expect(await openCard(db, id)).toBeNull();

    const { s, address: again } = await restart();
    expect((await openCard(db, id))?.field).toBe("purchaseInvoice"); // reconciled before the server listened
    expect(log(s, "recovery: active sessions reconciled")).toBeDefined();
    // A returning page sees the answer and the card, once.
    const page = connect(`${again.replace(/^http/, "ws")}/chat?sessionId=${id}`, { origin: CHAOS_ORIGIN });
    await page.opened;
    await until(async () => (page.messages as { type: string }[]).some((m) => m.type === "syncDone"), "the replay");
    const messages = page.messages as { type: string; id?: string; text?: string }[];
    expect(messages.filter((m) => m.type === "inputRequest").map((m) => m.id)).toEqual(["req_purchaseInvoice_1"]);
    expect(messages.some((m) => m.type === "message" && m.text === ANSWERS.serialNumber)).toBe(true);
    expect(await listFieldCandidates(db.pool, id, "serialNumber")).toHaveLength(1);
    page.ws.close();
    expect((await s.stop()).code).toBe(0);
  }, 90_000);

  it("2. after call.ended committed and before the next card: the restart opens it, and the call is ended exactly once", async () => {
    // The call was running when the process died; the card it was on had just been answered (its reaction never ran).
    const id = await sessionAtField(db, services, "serialNumber");
    await answer(testServices(db, { planner: false }), id, (await openCard(db, id))?.id ?? "", "serialNumber", ANSWERS.serialNumber);
    const callId = `c${id.slice(0, 8)}`;
    await services.processor.dispatch(id, { type: "StartCall", callId } as never);
    expect(await openCard(db, id)).toBeNull();

    // Boot recovery ends the call (a commit), and the process dies before anything that follows a commit.
    const first = server({ failpoints: "commit.after.EndCall" });
    expect(await exitsWithin(first)).toEqual({ code: null, signal: "SIGKILL" });
    expect((await listCalls(db.pool, id))[0]).toMatchObject({ endReason: "server_restart" });
    expect(await openCard(db, id)).toBeNull(); // the next card is missing
    expect((await getSession(db.pool, id))?.activeCallId).toBeNull();

    const { s } = await restart();
    expect((await openCard(db, id))?.field).toBe("purchaseInvoice");
    expect((await eventTypes(id)).filter((t) => t === "call.ended")).toHaveLength(1);
    expect(log(s, "recovery: dangling calls ended")?.count).toBe(0); // nothing left to end
    expect((await listCalls(db.pool, id))).toHaveLength(1);
    expect((await s.stop()).code).toBe(0);
  }, 90_000);

  it("3. in the middle of a finalization, before COMMIT: nothing was produced, and finalizing again makes exactly one revision", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    const first = server({ failpoints: "finalize.beforeCommit" });
    const address = await first.listening;
    await finalizeRequest(address, id).catch(() => undefined); // the connection dies with the process
    expect(await exitsWithin(first)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await revisions(id)).toEqual([]);
    expect(await listOutbox(db.pool, id)).toEqual([]);
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active", currentRevision: 0 });
    expect((await eventTypes(id)).filter((t) => t === "session.finalized")).toEqual([]);
    expect((await openCard(db, id))?.field).toBe("submitConfirmation"); // the user's card is still there

    const { s, address: again } = await restart();
    expect((await finalizeRequest(again, id)).status).toBe(200);
    expect(await revisions(id)).toEqual([1]);
    await until(async () => (await received(id)).length === 1, "delivery");
    expect((await received(id))[0]).toMatchObject({ idempotencyKey: `${id}:1`, timesReceived: 1 });
    expect((await finalizeRequest(again, id)).status).toBe(200); // a repeat is a no-op
    expect(await revisions(id)).toEqual([1]);
    expect((await s.stop()).code).toBe(0);
  }, 90_000);

  it("4. after a finalization committed, before delivery: the restart delivers it, once", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    const first = server({ failpoints: "finalize.afterCommit" });
    const address = await first.listening;
    await finalizeRequest(address, id).catch(() => undefined);
    expect(await exitsWithin(first)).toEqual({ code: null, signal: "SIGKILL" });
    // Durable: the record, the outbox row and the session; nothing delivered.
    expect(await revisions(id)).toEqual([1]);
    expect(await listOutbox(db.pool, id)).toMatchObject([{ revision: 1, status: "pending", attempts: 0 }]);
    expect(await received(id)).toEqual([]);
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "completed", currentRevision: 1 });

    const { s } = await restart();
    await until(async () => (await received(id)).length === 1, "delivery after the restart");
    expect((await received(id))[0]).toMatchObject({ idempotencyKey: `${id}:1`, timesReceived: 1, payload: { revision: 1, sessionId: id } });
    await until(async () => (await listOutbox(db.pool, id))[0]?.status === "delivered", "marked delivered");
    expect(await revisions(id)).toEqual([1]);
    expect((await s.stop()).code).toBe(0);
  }, 90_000);

  it("5. after the receiver got the POST, before it was marked delivered: delivered again, stored once, counter 2", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    const first = server({ failpoints: "delivery.afterPost" });
    const address = await first.listening;
    await finalizeRequest(address, id).catch(() => undefined);
    expect(await exitsWithin(first)).toEqual({ code: null, signal: "SIGKILL" });
    expect((await received(id)).map((r) => [r.idempotencyKey, r.timesReceived])).toEqual([[`${id}:1`, 1]]); // the receiver has it
    expect(await listOutbox(db.pool, id)).toMatchObject([{ revision: 1, status: "sending" }]); // ours doesn't know

    const { s } = await restart();
    expect(log(s, "recovery: outbox leases reclaimed")?.count).toBeGreaterThanOrEqual(1);
    await until(async () => (await received(id))[0]?.timesReceived === 2, "the redelivery");
    await until(async () => (await listOutbox(db.pool, id))[0]?.status === "delivered", "marked delivered");
    expect((await received(id)).map((r) => [r.idempotencyKey, r.timesReceived])).toEqual([[`${id}:1`, 2]]); // one row, two sightings
    expect(await revisions(id)).toEqual([1]);
    expect((await s.stop()).code).toBe(0);
  }, 90_000);
});

describe("a clean SIGTERM (a deploy), as a real process (P8-T02)", () => {
  it("exits 0 in under 10 s, tells the open chat socket 1012 and closes the database last", async () => {
    const id = randomUUID();
    const s = server();
    const address = await s.listening;
    const chat = connect(`${address.replace(/^http/, "ws")}/chat?sessionId=${id}`, { origin: CHAOS_ORIGIN });
    await chat.opened;
    await until(async () => (chat.messages as { type: string }[]).some((m) => m.type === "syncDone"), "the replay");
    const began = Date.now();
    const exit = await s.stop();
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await chat.closed).toMatchObject({ code: 1012, reason: "server restarting" });
    const steps = s.logs().filter((l) => l.msg === "shutdown step done").map((l) => l.step);
    expect(steps).toEqual(["close sockets", "settle calls", "stop sweeper", "drain commands", "stop outbox", "close database"]);
    expect(s.logs().at(-1)).toMatchObject({ msg: "shutdown complete" });
  }, 60_000);
});
