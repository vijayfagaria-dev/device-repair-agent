// The planner as an idempotent reconciler (P4-T01) against the throwaway test Postgres: a second reconcile writes
// nothing; a crash between "the call ended" and "the next card" is repaired at boot and on chat connect; concurrent
// reconciles never open two cards; the call agent's RequestInput queues cards the planner opens one at a time.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers } from "../../src/db/repos/timers.js";
import { createLogger } from "../../src/log.js";
import { ensureSession } from "../../src/session/ensureSession.js";
import { reconcileActiveSessions, type ReconcileReply, type RequestInputReply } from "../../src/session/handlers/requestInput.js";
import type { TimerFiredReply } from "../../src/session/handlers/timers.js";
import type { SessionServices } from "../../src/session/services.js";
import { connect, startApp } from "../helpers/app.js";
import { ANSWERS, answerOpen, cards, chatSession, openCard, startChat } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { endSeededCall, seedCall, testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let planner: SessionServices;
/** The same database without the planner: a process that crashed before its reaction ran. */
let crashed: SessionServices;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("reconcile", { max: 10 }));
  planner = testServices(db, { planner: true });
  crashed = testServices(db, { planner: false });
});
afterAll(async () => {
  await schema.drop();
});

const reconcile = (services: SessionServices, id: string) => services.processor.dispatch<ReconcileReply>(id, { type: "Reconcile" } as never);

/** A session whose call took two fields and then ended, with nothing reacting to the end (the crash gap). */
async function callEndedWithoutReaction(): Promise<string> {
  const id = await seedSession(db.pool);
  const callId = `c${id.slice(0, 8)}`;
  await seedCall(db, id, callId, new Date(Date.now() - 120_000));
  await crashed.processor.dispatch(id, { type: "Test.StartCall", callId } as never);
  for (const [field, normalized] of [
    ["deviceType", "smartphone"],
    ["deviceModel", { brand: "Apple", model: "iPhone 14 Pro" }],
  ] as const) {
    await crashed.processor.dispatch(id, { type: "Test.Candidate", field, source: "call", raw: "x", normalized, status: "valid" } as never);
  }
  await endSeededCall(db, callId);
  await crashed.processor.dispatch(id, { type: "Test.EndCall" } as never);
  return id;
}

describe("idempotency", () => {
  it("a second reconcile in a row writes nothing: no event, no version bump", async () => {
    const id = await callEndedWithoutReaction();
    const first = await reconcile(planner, id);
    expect(first.reply).toEqual({ mode: "chat", changed: true });
    const session = await getSession(db.pool, id);
    const events = await listEvents(db.pool, id);
    const second = await reconcile(planner, id);
    expect(second.reply).toEqual({ mode: "chat", changed: false });
    expect(second.update).toBeNull();
    expect(await getSession(db.pool, id)).toEqual(session);
    expect(await listEvents(db.pool, id)).toEqual(events);
  });

  it("concurrent reconciles and an answer never leave two cards open", async () => {
    const id = await chatSession(db, planner);
    await Promise.all([
      ...Array.from({ length: 8 }, () => reconcile(planner, id)),
      answerOpen(db, planner, id, "deviceType", "laptop"),
      ...Array.from({ length: 8 }, () => planner.processor.react(id)),
    ]);
    const open = (await cards(db, id)).filter((c) => c.status === "open");
    expect(open.map((c) => c.field)).toEqual(["deviceModel"]);
    expect((await getSession(db.pool, id))?.openRequestId).toBe(open[0]?.id);
  });
});

describe("the crash gap (P4-T01 acceptance): call ended, next card never sent", () => {
  it("boot reconciliation opens the card, continuing in chat without re-asking what the call collected", async () => {
    const id = await callEndedWithoutReaction();
    expect(await openCard(db, id)).toBeNull();
    const count = await reconcileActiveSessions(db.pool, planner.processor, createLogger("silent"));
    expect(count).toBeGreaterThanOrEqual(1);
    const open = await openCard(db, id);
    expect(open?.field).toBe("serialNumber");
    const lead = (await listEvents(db.pool, id)).filter((e) => e.type === "chat.message").at(-1)?.payload.message as { text: string };
    expect(lead.text).toMatch(/^Thanks for the call\. Let's finish the rest here in chat\./);
  });

  it("a chat connect reconciles too: the missing card arrives live after syncDone", async () => {
    const id = await callEndedWithoutReaction();
    const server = await startApp(db, { services: planner });
    try {
      const socket = connect(`${server.ws}/chat?sessionId=${id}`);
      await socket.opened;
      const messages = await waitForType(socket.messages, "inputRequest");
      const types = messages.map((m) => (m as { type: string }).type);
      expect(types.indexOf("syncDone")).toBeLessThan(types.indexOf("inputRequest"));
      expect(messages.find((m) => (m as { type: string }).type === "inputRequest")).toMatchObject({ id: "req_serialNumber_1", field: "serialNumber" });
      socket.ws.close();
    } finally {
      await server.close();
    }
  });

  it("boot reconciliation leaves finalized sessions and sessions still waiting for a call alone", async () => {
    const waiting = await seedSession(db.pool);
    const done = await chatSession(db, planner);
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", [done]);
    const doneBefore = await listEvents(db.pool, done);
    await reconcileActiveSessions(db.pool, planner.processor, createLogger("silent"));
    expect(await listEvents(db.pool, waiting)).toHaveLength(0);
    expect(await listEvents(db.pool, done)).toEqual(doneBefore);
  });
});

async function waitForType(messages: unknown[], type: string, timeoutMs = 3000): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  while (!messages.some((m) => (m as { type: string }).type === type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} message`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return messages;
}

describe("noCallStart (PD10, P4-T04)", () => {
  it("a new session starts with its deadline; when it passes without a call, the chat starts with the first card", async () => {
    const id = randomUUID();
    const scheduled: Date[] = [];
    const before = Date.now();
    await ensureSession(db.pool, id, { via: "chat", newSession: { noCallStartMs: 120_000, onTimerScheduled: (dueAt) => scheduled.push(dueAt) } });
    const [timer] = await listTimers(db.pool, id);
    expect(timer?.kind).toBe("noCallStart");
    expect(timer?.dueAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(scheduled).toEqual([timer?.dueAt]);

    await startChat(db, planner, id);
    const types = (await listEvents(db.pool, id)).map((e) => e.type);
    expect(types).toEqual(["session.created", "timer.fired", "chat.started", "chat.message", "chat.message", "input.requested"]);
    expect((await openCard(db, id))?.field).toBe("deviceType");
  });

  it("does nothing once a call has happened (the call drives the session)", async () => {
    const id = await seedSession(db.pool);
    await seedCall(db, id, `c${id.slice(0, 8)}`);
    await db.pool.query("INSERT INTO timers (session_id, kind, due_at) VALUES ($1, 'noCallStart', now() - interval '1 second')", [id]);
    const { reply } = await planner.processor.dispatch<TimerFiredReply>(id, { type: "TimerFired", kind: "noCallStart", dueAt: new Date() } as never);
    expect(reply).toEqual({ fired: false, reason: "notNeeded" });
    expect(await listTimers(db.pool, id)).toEqual([]);
  });

  it("existing sessions aren't given a timer when loaded", async () => {
    const id = await seedSession(db.pool);
    await ensureSession(db.pool, id, { via: "chat", newSession: { noCallStartMs: 1 } });
    expect(await listTimers(db.pool, id)).toEqual([]);
  });
});

describe("RequestInput (the call agent's request_chat_input)", () => {
  const request = (id: string, field: string) => planner.processor.dispatch<RequestInputReply>(id, { type: "RequestInput", field } as never);

  it("queues the card; the planner opens it (with a lead-in) when nothing else is open, one at a time", async () => {
    const id = await seedSession(db.pool);
    const callId = `c${id.slice(0, 8)}`;
    await seedCall(db, id, callId);
    await planner.processor.dispatch(id, { type: "Test.StartCall", callId } as never);
    expect((await request(id, "email")).reply).toEqual({ status: "queued", requestId: "req_email_1" });
    expect((await request(id, "serialNumber")).reply).toEqual({ status: "queued", requestId: "req_serialNumber_1" });
    expect((await cards(db, id)).map((c) => [c.id, c.status])).toEqual([
      ["req_email_1", "open"],
      ["req_serialNumber_1", "queued"],
    ]);
    await answerOpen(db, planner, id, "email", ANSWERS.email);
    expect((await openCard(db, id))?.id).toBe("req_serialNumber_1");
    const leadIns = (await listEvents(db.pool, id)).filter((e) => e.type === "chat.message").map((e) => (e.payload.message as { text: string }).text);
    expect(leadIns).toContain("I've sent you a box for your email address.");
  });

  it("refuses what isn't a chat card, is already provided or pending, or isn't ready", async () => {
    const id = await chatSession(db, planner);
    expect((await request(id, "deviceType")).reply).toEqual({ status: "refused", reason: "notAChatField" });
    expect((await request(id, "submitConfirmation")).reply).toEqual({ status: "refused", reason: "notReady" });
    expect((await request(id, "email")).reply).toEqual({ status: "queued", requestId: "req_email_1" });
    expect((await request(id, "email")).reply).toEqual({ status: "alreadyPending", requestId: "req_email_1" });
    await planner.processor.dispatch(id, { type: "Test.Candidate", field: "serviceCentre", source: "chat", raw: "x", normalized: { id: "blr-koramangala", name: "K", city: "B" }, status: "valid" } as never);
    expect((await request(id, "serviceCentre")).reply).toEqual({ status: "refused", reason: "alreadyProvided" });
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", [id]);
    expect((await request(id, "purchaseInvoice")).reply).toEqual({ status: "refused", reason: "notActive" });
  });
});
