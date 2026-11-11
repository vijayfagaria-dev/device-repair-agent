// P4 gate scenarios over real sockets and HTTP (fake nothing but the call side): a session run entirely in chat
// reaches a completed revision 1; a call that ended after two fields continues in chat without re-asking; the edit
// loop after "No"; three invalid answers; opt-out with and without a call (and declining it); upload rejections;
// a reload mid-way. After every step: at most one open card, and every server message is a valid protocol message.
import { randomUUID } from "node:crypto";
import { ChatServerMessageSchema } from "@device-repair/shared/protocol/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { validateRecord } from "../../src/domain/record.js";
import type { SessionServices } from "../../src/session/services.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { ANSWERS, EXE, PDF, PNG, startChat } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { endSeededCall, seedCall, TEST_FILE_URL_SECRET, testServices } from "../helpers/session.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("chatonly", { max: 10 }));
  services = testServices(db, { planner: true });
  server = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadsPerMinute: 1000 });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

type Msg = { type: string; id?: string; [key: string]: unknown };

/** Drives one /chat socket like the page does: waits for the next card, answers it, uploads files. */
class Chat {
  readonly socket: TestSocket;
  #read = 0;

  constructor(readonly sessionId: string) {
    this.socket = connect(`${server.ws}/chat?sessionId=${sessionId}`);
  }

  get all(): Msg[] {
    return this.socket.messages as Msg[];
  }

  /** Waits for the end of the replay without consuming it: a replayed card is the next card to answer. */
  async ready(): Promise<this> {
    await this.socket.opened;
    const deadline = Date.now() + 3000;
    while (!this.all.some((m) => m.type === "syncDone")) {
      if (Date.now() > deadline) throw new Error("no syncDone");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this;
  }

  /** The next message matching `test` after the ones already consumed. */
  async until(test: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.all.findIndex((m, i) => i >= this.#read && test(m));
      if (index >= 0) {
        this.#read = index + 1;
        return this.all[index] as Msg;
      }
      if (Date.now() > deadline) throw new Error(`timed out; last messages: ${JSON.stringify(this.all.slice(-4))}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  card = () => this.until((m) => m.type === "inputRequest");

  async answer(card: Msg, value: unknown): Promise<void> {
    await invariants(this.sessionId);
    this.socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: card.id, field: card.field, value }));
  }

  async upload(bytes: Buffer, name: string, type: string): Promise<Response> {
    const body = new FormData();
    body.append("file", new Blob([bytes], { type }), name);
    return fetch(`${server.http}/sessions/${this.sessionId}/files`, { method: "POST", body });
  }

  async uploadRef(bytes = PDF, name = "invoice.pdf", type = "application/pdf"): Promise<string> {
    const response = await this.upload(bytes, name, type);
    expect(response.status).toBe(200);
    return ((await response.json()) as { url: string }).url;
  }

  /** Answers the open card for `field` with a valid value. */
  async give(field: string, value?: unknown): Promise<Msg> {
    const card = await this.card();
    expect(card.field).toBe(field);
    const chosen = value !== undefined ? value : field === "purchaseInvoice" ? await this.uploadRef() : ANSWERS[field];
    await this.answer(card, chosen);
    return card;
  }

  close(): void {
    this.socket.ws.close();
  }
}

/** Checked after every step: at most one open card, and the session row agrees with it. */
async function invariants(sessionId: string): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>("SELECT id FROM input_requests WHERE session_id = $1 AND status = 'open'", [sessionId]);
  expect(rows.length).toBeLessThanOrEqual(1);
  expect((await getSession(db.pool, sessionId))?.openRequestId ?? null).toBe(rows[0]?.id ?? null);
}

function expectValidProtocol(chat: Chat): void {
  for (const message of chat.all) expect(ChatServerMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
}

/** A new session (created by the socket, as the browser does) whose noCallStart deadline has passed. */
async function chatOnlySession(): Promise<Chat> {
  const chat = await new Chat(randomUUID()).ready();
  await startChat(db, services, chat.sessionId);
  return chat;
}

const NO_CALL_ORDER = ["deviceType", "deviceModel", "problemDescription", "problemStartedAt", "urgency", "serialNumber", "purchaseInvoice", "serviceCentre", "email"];

async function confirm(chat: Chat, yes: boolean): Promise<Msg> {
  const summary = await chat.until((m) => m.type === "message" && String(m.text).startsWith("Here's your claim:"));
  const card = await chat.card();
  expect(card).toMatchObject({ field: "submitConfirmation", kind: "confirm" });
  await chat.answer(card, yes);
  return summary;
}

describe("chat-only mode (P4-T04)", () => {
  it("a session with zero calls reaches a completed revision 1, with the record shown in the chat", async () => {
    const chat = await chatOnlySession();
    expect(await chat.until((m) => m.type === "message")).toMatchObject({ role: "agent", text: "No problem if you'd rather not call. We can do everything here in chat." });
    for (const field of NO_CALL_ORDER) await chat.give(field);
    await chat.give("additionalPhotos", null); // Skip
    await chat.give("additionalNotes", "Please call before visiting.");
    const summary = await confirm(chat, true);
    expect(summary.text).toContain("• Email address: asha.rao@example.com");
    expect(summary.text).toContain("• Notes: Please call before visiting.");

    const record = await chat.until((m) => m.type === "record");
    expect(record.id).toBe("rec_1");
    validateRecord(record.record);
    expectSanitizedRecord(record.record, { secrets: FAKE_SECRET_VALUES });
    expect(record.record).toMatchObject({ revision: 1, outcome: "completed", sessionId: chat.sessionId, engagement: { calls: 0 } });
    expect(await chat.until((m) => m.type === "message")).toMatchObject({ text: "Thanks, your claim is submitted. We'll email you with updates." });
    expect(await chat.until((m) => m.type === "sessionState" && m.status === "finalized")).toMatchObject({ outcome: "completed", revision: 1 });

    const records = await listRecords(db.pool, chat.sessionId);
    expect(records.map((r) => [r.revision, r.outcome])).toEqual([[1, "completed"]]);
    expect((await (await fetch(`${server.http}/api/sessions/${chat.sessionId}/records`)).json()) as object).toMatchObject({ records: [{ revision: 1, outcome: "completed" }] });
    await invariants(chat.sessionId);
    expectValidProtocol(chat);
    chat.close();
  });

  it("a call that ended after two fields continues in chat with no re-asking", async () => {
    const id = randomUUID();
    const chat = await new Chat(id).ready();
    const callId = `c${id.slice(0, 8)}`;
    await seedCall(db, id, callId, new Date(Date.now() - 90_000));
    await services.processor.dispatch(id, { type: "Test.StartCall", callId } as never);
    await services.processor.dispatch(id, { type: "Test.Candidate", field: "deviceType", source: "call", raw: "a phone", normalized: "smartphone", status: "valid" } as never);
    await services.processor.dispatch(id, { type: "Test.Candidate", field: "deviceModel", source: "call", raw: "iPhone 14 Pro", normalized: { brand: "Apple", model: "iPhone 14 Pro" }, status: "valid" } as never);
    await endSeededCall(db, callId);
    await services.processor.dispatch(id, { type: "Test.EndCall" } as never);

    const asked: string[] = [];
    for (;;) {
      const card = await chat.card();
      if (card.field === "submitConfirmation") {
        await chat.answer(card, true);
        break;
      }
      asked.push(String(card.field));
      await chat.answer(card, card.field === "purchaseInvoice" ? await chat.uploadRef() : ANSWERS[String(card.field)]);
    }
    expect(asked).toEqual(["serialNumber", "purchaseInvoice", "serviceCentre", "email", "problemDescription", "problemStartedAt", "urgency", "additionalPhotos", "additionalNotes"]);
    const lead = chat.all.find((m) => m.type === "message" && String(m.text).startsWith("Thanks for the call."));
    expect(lead).toBeDefined();
    const record = await chat.until((m) => m.type === "record");
    expect(record.record).toMatchObject({ outcome: "completed", engagement: { calls: 1 } });
    expect((record.record as { fields: { deviceModel: unknown } }).fields.deviceModel).toMatchObject({ source: "call", value: { brand: "Apple", model: "iPhone 14 Pro" } });
    expectValidProtocol(chat);
    chat.close();
  });

  it("No on Submit claim? → What would you like to change? → that field is asked again → Submit claim? again", async () => {
    const chat = await chatOnlySession();
    for (const field of NO_CALL_ORDER) await chat.give(field);
    await chat.give("additionalPhotos", null);
    await chat.give("additionalNotes", null);
    await confirm(chat, false);
    const edit = await chat.card();
    expect(edit).toMatchObject({ id: "req_editField_1", field: "editField", kind: "select" });
    expect((edit.options as { value: string }[]).map((o) => o.value)).toContain("email");
    await chat.answer(edit, "email");
    expect(await chat.until((m) => m.type === "message" && m.role === "agent")).toMatchObject({ text: "Sure. What's the correct email address?" });
    const again = await chat.card();
    expect(again).toMatchObject({ id: "req_email_2", field: "email" });
    await chat.answer(again, "asha.new@example.com");
    const summary = await chat.until((m) => m.type === "message" && String(m.text).startsWith("Here's your claim:"));
    expect(summary.text).toContain("• Email address: asha.new@example.com");
    const confirmAgain = await chat.card();
    expect(confirmAgain.id).toBe("req_submitConfirmation_2");
    await chat.answer(confirmAgain, true);
    const record = await chat.until((m) => m.type === "record");
    expect((record.record as { fields: { email: { value: string } } }).fields.email.value).toBe("asha.new@example.com");
    expectValidProtocol(chat);
    chat.close();
  });

  it("three invalid serial numbers: two inputErrors, then the card closes, the flow carries on, and no confirmation is offered", async () => {
    const chat = await chatOnlySession();
    for (const field of NO_CALL_ORDER.slice(0, 5)) await chat.give(field);
    const serial = await chat.card();
    await chat.answer(serial, "1234");
    expect(await chat.until((m) => m.type === "inputError")).toMatchObject({ id: "err_req_serialNumber_1_1", message: "That IMEI has 4 digits; IMEIs have 15." });
    await chat.answer(serial, "1234");
    expect(await chat.until((m) => m.type === "inputError")).toMatchObject({ id: "err_req_serialNumber_1_2" });
    await chat.answer(serial, "1234");
    expect(await chat.until((m) => m.type === "inputCancel")).toMatchObject({ requestId: "req_serialNumber_1", reason: "too many attempts" });
    for (const field of ["purchaseInvoice", "serviceCentre", "email"]) await chat.give(field);
    await chat.give("additionalPhotos", null);
    await chat.give("additionalNotes", null);
    expect(await chat.until((m) => m.type === "message" && String(m.text).startsWith("That's everything I can collect here."))).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(chat.all.filter((m) => m.type === "inputRequest" && m.field === "submitConfirmation")).toEqual([]);
    expect((await getSession(db.pool, chat.sessionId))?.status).toBe("active"); // idle → needsReview is P7-T01
    expectValidProtocol(chat);
    chat.close();
  });

  it("an upload the server refuses leaves the card open; a good one then answers it", async () => {
    const chat = await chatOnlySession();
    for (const field of NO_CALL_ORDER.slice(0, 6)) await chat.give(field);
    const invoice = await chat.card();
    expect(invoice.field).toBe("purchaseInvoice");
    const refused = await chat.upload(EXE, "invoice.pdf", "application/pdf");
    expect(refused.status).toBe(415);
    const heic = await chat.upload(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]), "x.heic", "image/heic");
    expect(heic.status).toBe(415);
    await chat.answer(invoice, await chat.uploadRef(PNG, "invoice.png", "image/png"));
    expect(await chat.card()).toMatchObject({ field: "serviceCentre" });
    chat.close();
  });

  it("a reload mid-way replays the thread and the same open card, and the session carries on", async () => {
    const first = await chatOnlySession();
    for (const field of NO_CALL_ORDER.slice(0, 3)) await first.give(field);
    const open = await first.card();
    first.close();
    await first.socket.closed;

    const second = await new Chat(first.sessionId).ready();
    const replayed = second.all.slice(0, second.all.findIndex((m) => m.type === "syncDone"));
    expect(replayed.filter((m) => m.type === "inputRequest").map((m) => m.id)).toEqual([open.id]);
    expect(replayed.filter((m) => m.type === "message" && m.role === "user").map((m) => m.requestId)).toEqual(["req_deviceType_1", "req_deviceModel_1", "req_problemDescription_1"]);
    // The replayed card is the one to answer, and the session goes on from there.
    await second.give("problemStartedAt");
    expect(await second.card()).toMatchObject({ field: "urgency" });
    expectValidProtocol(second);
    second.close();
  });
});

describe("opt-out from chat (P4-T05)", () => {
  it("Stop pauses the open card and asks to confirm; No brings the same card back; Stop again and Yes → optedOut", async () => {
    const chat = await chatOnlySession();
    for (const field of NO_CALL_ORDER.slice(0, 5)) await chat.give(field);
    const serial = await chat.card();
    expect(serial.id).toBe("req_serialNumber_1");

    chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    const ask = await chat.card();
    expect(ask).toMatchObject({ id: "req_optOutConfirmation_1", field: "optOutConfirmation", kind: "confirm", label: "Stop your claim?" });
    await invariants(chat.sessionId);
    chat.socket.ws.send(JSON.stringify({ type: "optOut" })); // a double tap asks nothing new: the open card is re-sent
    expect(await chat.card()).toMatchObject({ id: "req_optOutConfirmation_1" });
    await chat.answer(ask, false);
    expect(await chat.until((m) => m.type === "message" && m.role === "agent")).toMatchObject({ text: "OK, let's carry on." });
    expect(await chat.card()).toMatchObject({ id: "req_serialNumber_1", field: "serialNumber" }); // the same card, back

    chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    const again = await chat.card();
    expect(again.id).toBe("req_optOutConfirmation_2");
    await chat.answer(again, true);
    expect(await chat.until((m) => m.type === "inputCancel")).toMatchObject({ requestId: "req_serialNumber_1" });
    const record = await chat.until((m) => m.type === "record");
    validateRecord(record.record);
    expectSanitizedRecord(record.record, { secrets: FAKE_SECRET_VALUES });
    expect(record.record).toMatchObject({ revision: 1, outcome: "optedOut" });
    expect((record.record as { fields: { deviceType: { status: string } } }).fields.deviceType.status).toBe("valid"); // kept
    // Two confirmation cards (the double tap re-sent the first, it didn't make a new one).
    expect(new Set(chat.all.filter((m) => m.type === "inputRequest" && m.field === "optOutConfirmation").map((m) => m.id))).toEqual(
      new Set(["req_optOutConfirmation_1", "req_optOutConfirmation_2"]),
    );
    expectValidProtocol(chat);
    chat.close();
  });

  it("with a call active: Yes produces an optedOut record (ending the call itself is the call engine's, P5-T09)", async () => {
    // The call is set up before the chat connects: a call row that isn't active yet looks like an ended call, and the
    // connect's reconcile would rightly open a chat card for it (StartCall does both in one command in production).
    const id = await seedSession(db.pool);
    const callId = `c${id.slice(0, 8)}`;
    await seedCall(db, id, callId);
    await services.processor.dispatch(id, { type: "Test.StartCall", callId } as never);
    const chat = await new Chat(id).ready();
    chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    const ask = await chat.card();
    expect(ask.field).toBe("optOutConfirmation");
    await chat.answer(ask, true);
    const record = await chat.until((m) => m.type === "record");
    expect(record.record).toMatchObject({ outcome: "optedOut", engagement: { calls: 1 } });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "optedOut", activeCallId: callId });
    chat.close();
  });

  it("Stop on a finalized claim does nothing", async () => {
    const chat = await chatOnlySession();
    await chat.card(); // the first card is still on its way over the socket; count after it
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", [chat.sessionId]);
    const count = chat.all.length;
    chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(chat.all.slice(count).filter((m) => m.type === "inputRequest")).toEqual([]);
    chat.close();
  });
});

describe("two tabs", () => {
  it("an answer in one tab reaches the other as the user's message with its requestId, then the next card", async () => {
    const a = await chatOnlySession();
    const b = await new Chat(a.sessionId).ready();
    const card = await a.card();
    expect(await b.card()).toMatchObject({ id: card.id }); // replayed in tab b
    await a.answer(card, ANSWERS.deviceType);
    expect(await b.until((m) => m.type === "message" && m.role === "user")).toMatchObject({ requestId: card.id, text: "Phone" });
    expect(await b.card()).toMatchObject({ field: "deviceModel" });
    a.close();
    b.close();
  });
});

describe("inbound limit per socket (P4-T02; deferred from the P3 audit)", () => {
  it("answers beyond 20 in 10 s get inputError 'too quickly' without reaching the database; the socket stays open", async () => {
    const chat = await chatOnlySession();
    const card = await chat.card();
    const before = (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE session_id = $1", [chat.sessionId])).rows[0]?.n;
    for (let i = 0; i < 25; i++) chat.socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: "req_nope_1", field: "x", value: "x" }));
    await chat.until((m) => m.type === "inputError" && String(m.message).startsWith("You're sending answers too quickly"));
    // All 25 replies, not a fixed sleep: a slow CI machine takes longer than 200 ms to answer them.
    for (let waited = 0; chat.all.filter((m) => m.type === "inputError").length < 25 && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    const errors = chat.all.filter((m) => m.type === "inputError").map((m) => m.message);
    expect(errors.filter((m) => String(m).startsWith("You're sending answers too quickly"))).toHaveLength(5);
    expect(errors.filter((m) => m === "This request is no longer active.")).toHaveLength(20);
    const after = (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE session_id = $1", [chat.sessionId])).rows[0]?.n;
    expect(after).toBe(before); // stale answers write nothing
    expect(chat.socket.ws.readyState).toBe(chat.socket.ws.OPEN);
    expect(card.field).toBe("deviceType");
    chat.close();
  });
});

describe("P4 review #1: an answer that lands after Stop paused its card", () => {
  it("gets 'no longer active' followed by the card that is open, and the flow recovers", async () => {
    const chat = await chatOnlySession();
    for (const field of NO_CALL_ORDER.slice(0, 6)) await chat.give(field);
    const invoice = await chat.card();
    const ref = await chat.uploadRef(); // the upload is slow; meanwhile the user taps Stop
    chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    const ask = await chat.card();
    expect(ask.field).toBe("optOutConfirmation");
    await chat.answer(invoice, ref); // the late answer to the paused card
    expect(await chat.until((m) => m.type === "inputError")).toMatchObject({ requestId: invoice.id, message: "This request is no longer active." });
    expect(await chat.card()).toMatchObject({ id: ask.id }); // re-sent right after the error
    await chat.answer(ask, false);
    expect(await chat.card()).toMatchObject({ id: invoice.id }); // resumed
    await chat.answer(invoice, ref);
    expect(await chat.card()).toMatchObject({ field: "serviceCentre" });
    chat.close();
  });
});
