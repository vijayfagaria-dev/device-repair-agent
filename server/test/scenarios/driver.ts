// The driver for full-session scenarios (P9-T01): one script drives the chat socket, the call socket and the fake
// providers of a real server over a throwaway database, and an invariant checker runs after every step.
// The fakes drive the provider seam only; nothing here says anything about the real providers (that is P9-T03).
import { randomUUID } from "node:crypto";
import { ChatServerMessageSchema } from "@device-repair/shared/protocol/schemas";
import { expect } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listOutbox } from "../../src/db/repos/outbox.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { validateRecord } from "../../src/domain/record.js";
import type { SessionServices } from "../../src/session/services.js";
import { FakeLlm, type LlmScript } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { ANSWERS, PDF } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";
import { sleep } from "../helpers/seed.js";
import { TEST_FILE_URL_SECRET, testServices } from "../helpers/session.js";

export type Msg = { type: string; id?: string; [key: string]: unknown };

export async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(8);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Invariants: what must hold after every step, whatever the scenario.

/** Statement-level append-only triggers fire even when no row matches, so this changes nothing. */
const IMMUTABLE = ["events", "field_candidates", "records"] as const;

export async function checkInvariants(db: Database, sessionId: string): Promise<void> {
  const session = await getSession(db.pool, sessionId);
  expect(session, "the session exists").not.toBeNull();
  // At most one open card, and the session points at it.
  const open = (await db.pool.query<{ id: string }>("SELECT id FROM input_requests WHERE session_id = $1 AND status = 'open'", [sessionId])).rows;
  expect(open.length, "at most one open card").toBeLessThanOrEqual(1);
  expect(session?.openRequestId ?? null, "open_request_id matches the open card").toBe(open[0]?.id ?? null);
  // At most one running call, and the session points at it.
  const running = (await db.pool.query<{ id: string }>("SELECT id FROM calls WHERE session_id = $1 AND ended_at IS NULL", [sessionId])).rows;
  expect(running.length, "at most one running call").toBeLessThanOrEqual(1);
  expect(session?.activeCallId ?? null, "active_call_id matches the running call").toBe(running[0]?.id ?? null);
  // Events are contiguous from 1: nothing lost, nothing reordered.
  const seqs = (await listEvents(db.pool, sessionId)).map((e) => e.seq);
  expect(seqs, "event seq contiguous").toEqual(seqs.map((_, i) => i + 1));
  // Records: contiguous revisions, schema-valid and sanitized, one outbox row each, the session agrees.
  const records = await listRecords(db.pool, sessionId);
  expect(records.map((r) => r.revision), "revisions contiguous").toEqual(records.map((_, i) => i + 1));
  for (const record of records) {
    validateRecord(record.payload);
    expectSanitizedRecord(record.payload, { secrets: FAKE_SECRET_VALUES });
    expect(record.payload.revision).toBe(record.revision);
    expect(record.payload.sessionId).toBe(sessionId);
  }
  expect(session?.currentRevision, "current_revision is the latest revision").toBe(records.length);
  expect((await listOutbox(db.pool, sessionId)).map((o) => o.revision), "one outbox row per revision").toEqual(records.map((r) => r.revision));
  if (session?.status === "finalized") expect(session.outcome, "a finalized session has an outcome").not.toBeNull();
  // History cannot be rewritten.
  for (const table of IMMUTABLE) await expect(db.pool.query(`UPDATE ${table} SET session_id = session_id WHERE false`), `${table} is append-only`).rejects.toThrow();
}

export function expectValidProtocol(messages: readonly Msg[]): void {
  for (const message of messages) expect(ChatServerMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------

export class Chat {
  readonly socket: TestSocket;
  #read = 0;
  constructor(
    readonly run: Run,
    url: string,
  ) {
    this.socket = connect(url);
  }
  get all(): Msg[] {
    return this.socket.messages as Msg[];
  }
  async ready(): Promise<this> {
    await this.socket.opened;
    await waitFor(() => this.all.some((m) => m.type === "syncDone"), "syncDone");
    return this;
  }
  /** The next message after the ones consumed that matches. */
  async until(test: (m: Msg) => boolean, timeoutMs = 4_000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.all.findIndex((m, i) => i >= this.#read && test(m));
      if (index >= 0) {
        this.#read = index + 1;
        return this.all[index] as Msg;
      }
      if (Date.now() > deadline) throw new Error(`timed out; last messages: ${JSON.stringify(this.all.slice(-4))}`);
      await sleep(8);
    }
  }
  /** Marks everything so far as read (what a reload shows is checked from a fresh socket). */
  skipToEnd(): void {
    this.#read = this.all.length;
  }
  card = (field?: string) => this.until((m) => m.type === "inputRequest" && (field === undefined || m.field === field));
  async answer(card: Msg, value: unknown): Promise<void> {
    await this.run.step(`before answering ${String(card.field)}`);
    this.socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: card.id, field: card.field, value }));
  }
  async upload(bytes: Buffer = PDF, name = "invoice.pdf", type = "application/pdf"): Promise<string> {
    const body = new FormData();
    body.append("file", new Blob([bytes], { type }), name);
    const response = await fetch(`${this.run.rig.server.http}/sessions/${this.run.id}/files`, { method: "POST", body });
    expect(response.status).toBe(200);
    return ((await response.json()) as { url: string }).url;
  }
  /** Answers the next card, which must be for `field`, with a valid value (a file card gets an uploaded PDF). */
  async give(field: string, value?: unknown): Promise<Msg> {
    const card = await this.card();
    expect(card.field).toBe(field);
    await this.answer(card, value !== undefined ? value : field === "purchaseInvoice" ? await this.upload() : ANSWERS[field]);
    return card;
  }
  /** Chat-flow answers up to (not including) Submit claim?, from the next card on. */
  async fillRest(): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const card = await this.card();
      if (card.field === "submitConfirmation") {
        // Put it back: the caller answers it.
        this.#read = this.all.indexOf(card);
        return;
      }
      await this.answer(card, card.field === "purchaseInvoice" ? await this.upload() : ANSWERS[card.field as string] ?? null);
    }
    throw new Error("never reached Submit claim?");
  }
  close(): void {
    this.socket.ws.close();
  }
}

export class Call {
  constructor(
    readonly run: Run,
    readonly socket: TestSocket,
  ) {}
  get stt() {
    return this.run.rig.stt;
  }
  /** The customer speaks; the model's next turns are scripted (a tool-call turn and then the follow-up speech). */
  async say(text: string, ...scripts: LlmScript[]): Promise<void> {
    this.run.rig.llm.enqueue(...scripts);
    this.stt.current.say(text);
    await waitFor(() => this.run.rig.llm.queued === 0, "the scripted turns to be taken");
    await sleep(60); // the turn's effects commit and the follow-up plays
    await this.run.step(`after saying "${text.slice(0, 30)}"`);
  }
  async hangUp(): Promise<void> {
    this.socket.ws.close(1000);
    await waitFor(async () => (await getSession(this.run.rig.db.pool, this.run.id))?.activeCallId === null, "the call to end");
    await this.run.step("after hang-up");
  }
}

export class Run {
  chat!: Chat;
  constructor(
    readonly rig: Rig,
    readonly id: string,
  ) {}
  async step(label: string): Promise<void> {
    try {
      await checkInvariants(this.rig.db, this.id);
    } catch (err) {
      throw new Error(`invariant broken ${label}: ${(err as Error).message}`);
    }
  }
  /** Starts a call; the model's greeting is scripted. Resolves once the providers are open. */
  async startCall(greeting = "Hi, I'm Riya from device repairs. What's wrong with your device?"): Promise<Call> {
    this.rig.llm.enqueue({ text: greeting });
    const socket = connect(`${this.rig.server.ws}/call?sessionId=${this.id}`);
    await socket.opened;
    await waitFor(() => this.rig.stt.streams.length > 0, "the providers to open");
    await waitFor(async () => (await getSession(this.rig.db.pool, this.id))?.activeCallId != null, "the call to start");
    await waitFor(() => this.rig.llm.queued === 0, "the greeting");
    await sleep(60);
    await this.step("after the call started");
    return new Call(this, socket);
  }
  async session() {
    const session = await getSession(this.rig.db.pool, this.id);
    if (!session) throw new Error("the session does not exist");
    return session;
  }
  async records() {
    return listRecords(this.rig.db.pool, this.id);
  }
  /** A reload or a second tab: a fresh chat socket on the same session. */
  async openChat(): Promise<Chat> {
    return new Chat(this, `${this.rig.server.ws}/chat?sessionId=${this.id}`).ready();
  }
}

export class Rig {
  stt = new FakeStt();
  tts = new FakeTts();
  llm = new FakeLlm();
  private constructor(
    readonly schema: TestSchema,
    readonly db: Database,
    readonly services: SessionServices,
    readonly server: RunningApp,
  ) {}

  static async create(name: string): Promise<Rig> {
    const { schema, db } = await createMigratedSchema(name, { max: 12 });
    const services = testServices(db, { planner: true });
    let rig!: Rig;
    const server = await startApp(db, {
      services,
      fileUrlSecret: TEST_FILE_URL_SECRET,
      uploadsPerMinute: 1000,
      voice: { providers: () => ({ stt: rig.stt, tts: rig.tts, llm: rig.llm }), maxConcurrentCalls: 4, timings: { silenceMs: 60_000 } },
    });
    rig = new Rig(schema, db, services, server);
    rig.llm.fallback = { text: "Okay." };
    return rig;
  }

  /** New fakes for the next scenario (the server, database and sockets stay). */
  fresh(): void {
    this.stt = new FakeStt();
    this.tts = new FakeTts();
    this.llm = new FakeLlm();
    this.llm.fallback = { text: "Okay." };
  }

  /** A new session, created by its chat socket as the browser does. */
  async newRun(): Promise<Run> {
    this.fresh();
    const run = new Run(this, randomUUID());
    run.chat = await new Chat(run, `${this.server.ws}/chat?sessionId=${run.id}`).ready();
    return run;
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.schema.drop();
  }
}

/** The tool call the model makes for one spoken field. */
export const save = (field: string, value: string, evidence: string, userConfirmed = false) => ({
  name: "save_field",
  args: { field, value, spoken_evidence: evidence, ...(userConfirmed ? { user_confirmed: true } : {}) },
});
/** One turn in which the model saves all five voice fields (acknowledge-then-ask: the follow-up is its own script). */
export const FIVE_VOICE_FIELDS: LlmScript = {
  toolCalls: [
    save("deviceType", "smartphone", "it's my phone"),
    save("deviceModel", "Apple iPhone 14 Pro", "an iPhone 14 Pro"),
    save("problemDescription", "Screen flickers and goes black after a drop", "the screen flickers and goes black after I dropped it"),
    save("problemStartedAt", "last Tuesday", "it started last Tuesday"),
    save("urgency", "high", "I need it for work tomorrow"),
  ],
};
export const FIVE_VOICE_WORDS = "It's my phone, an iPhone 14 Pro. The screen flickers and goes black after I dropped it. It started last Tuesday and I need it for work tomorrow.";
