// WS /chat replay, live fan-out and inbound validation (P3-T04; protocol.md §3.3–§4), over real sockets and the
// throwaway test Postgres. Commands come from test-only handlers that write what P4/P5 handlers will.
import { randomUUID } from "node:crypto";
import { ChatServerMessageSchema } from "@device-repair/shared/protocol/schemas";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { insertRecord } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers } from "../../src/db/repos/timers.js";
import type { SessionServices } from "../../src/session/services.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { HASH, seedSession } from "../helpers/seed.js";
import { seedCall, testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("chatreplay", { max: 10 }));
  services = testServices(db);
  server = await startApp(db, { services });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

type Msg = { type: string; id?: string } & Record<string, unknown>;
const run = (id: string, command: object) => services.processor.dispatch(id, command as never);

/** Opens /chat and waits until the replay has ended (syncDone). */
async function openChat(id: string, app = server): Promise<TestSocket & { all: () => Msg[] }> {
  const socket = connect(`${app.ws}/chat?sessionId=${id}`);
  await socket.opened;
  await waitFor(() => (socket.messages as Msg[]).some((m) => m.type === "syncDone"), "syncDone");
  return Object.assign(socket, { all: () => socket.messages as Msg[] });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The replay's first statement: commits before it are in the replay's snapshot, commits after it aren't. */
const REPLAY_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const afterSync = (messages: Msg[]) => messages.slice(messages.findIndex((m) => m.type === "syncDone") + 1);
const beforeSync = (messages: Msg[]) => messages.slice(0, messages.findIndex((m) => m.type === "syncDone"));
/** History and cards: what the thread shows (sessionState/syncDone are status, not thread items). */
const thread = (messages: Msg[]) => messages.filter((m) => m.type !== "sessionState" && m.type !== "syncDone");

/** Acts out a session: agent and user chat, call transcript lines, then an open card. */
async function act(id: string): Promise<void> {
  const callId = `c${id.slice(0, 8)}`;
  await seedCall(db, id, callId);
  await run(id, { type: "Test.StartCall", callId });
  await run(id, { type: "Test.Transcript", lineId: `ta_${callId}_1`, callId, role: "agent", text: "Hi! What device is it?" });
  await run(id, { type: "Test.Transcript", lineId: `tu_${callId}_1`, callId, role: "user", text: "An iPhone 14 Pro" });
  await run(id, { type: "Test.Say", messageId: `a${id.slice(0, 6)}`, text: "I've sent a box for your serial number." });
  await run(id, { type: "Test.OpenCard", requestId: "req_email_1", field: "email" });
  await run(id, { type: "Test.Say", messageId: `u${id.slice(0, 6)}`, role: "user", text: "asha@example.com", requestId: "req_email_1" });
  await run(id, { type: "Test.CancelCard", requestId: "req_email_1" });
  await run(id, { type: "Test.OpenCard", requestId: "req_serialNumber_1", field: "serialNumber" });
  await run(id, { type: "Test.EndCall" });
}

describe("replay (protocol.md §4)", () => {
  it("a new session replays only its state and syncDone, all valid protocol messages", async () => {
    const id = randomUUID();
    const socket = await openChat(id);
    expect(socket.all()).toEqual([
      { type: "sessionState", id: "state_0", status: "active", callActive: false, outcome: null, revision: null, voiceAvailable: true, notice: null },
      { type: "syncDone", id: "sync_1", lastSeq: 1 }, // session.created
    ]);
    socket.ws.close();
  });

  it("act, disconnect, reconnect: the replayed thread equals the live one (ids and order)", async () => {
    const id = await seedSession(db.pool);
    const live = await openChat(id);
    await act(id);
    await waitFor(() => thread(afterSync(live.all())).some((m) => m.id === "req_serialNumber_1"), "the last card");
    live.ws.close();

    const replayed = await openChat(id);
    const liveThread = thread(afterSync(live.all()));
    const replayThread = thread(beforeSync(replayed.all()));
    // Live, the thread also saw the cancelled card come and go; a reload shows only what's still there (§4 step 3.2).
    const settled = liveThread.filter((m) => m.id !== "req_email_1" && m.id !== "cancel_req_email_1");
    expect(replayThread).toEqual(settled);
    expect(replayThread.map((m) => m.id)).toEqual([
      `ta_c${id.slice(0, 8)}_1`,
      `tu_c${id.slice(0, 8)}_1`,
      `m_a${id.slice(0, 6)}`,
      `m_u${id.slice(0, 6)}`,
      "req_serialNumber_1",
    ]);
    for (const message of replayed.all()) expect(ChatServerMessageSchema.safeParse(message).success, message.type).toBe(true);
    for (const message of live.all()) expect(ChatServerMessageSchema.safeParse(message).success, message.type).toBe(true);
    replayed.ws.close();
  });

  it("replays the latest record and the session state, and a server restart changes nothing", async () => {
    const id = await seedSession(db.pool);
    await act(id);
    await insertRecord(db.pool, { sessionId: id, revision: 1, outcome: "partial" as never, payload: { revision: 1, outcome: "partial" }, contentHash: HASH });
    await insertRecord(db.pool, { sessionId: id, revision: 2, outcome: "completed" as never, payload: { revision: 2, outcome: "completed" }, contentHash: "1".repeat(64) });
    const first = await openChat(id);
    expect(first.all().filter((m) => m.type === "record")).toEqual([{ type: "record", id: "rec_2", record: { revision: 2, outcome: "completed" } }]);
    first.ws.close();

    const restarted = await startApp(db, { services: testServices(db) }); // a new process: empty hub, nothing in memory
    try {
      const second = await openChat(id, restarted);
      expect(second.all()).toEqual(first.all());
      second.ws.close();
    } finally {
      await restarted.close();
    }
  });

  it("an event committed while the replay is being read arrives exactly once", async () => {
    const id = await seedSession(db.pool);
    // The socket's pool pauses around its replay's snapshot: one message commits just before the snapshot starts (so
    // it's in the replay AND in the hub buffer, filtered by seq), one just after lastSeq is read (only in the buffer).
    // A card opened then is not in the replay either (one snapshot), so it arrives live, after the message before it.
    let armed = true;
    const hooked = hookPool(db.pool, async (text, values, phase) => {
      if (!armed) return;
      if (phase === "before" && text.startsWith(REPLAY_BEGIN)) {
        await run(id, { type: "Test.Say", messageId: `before${id.slice(0, 4)}`, text: "committed before lastSeq" });
      } else if (phase === "after" && values?.[0] === id && text.includes("max(seq)")) {
        armed = false;
        await run(id, { type: "Test.Say", messageId: `after${id.slice(0, 4)}`, text: "committed after lastSeq" });
        await run(id, { type: "Test.OpenCard", requestId: "req_email_1", field: "email" });
      }
    });
    const app = await startApp({ pool: hooked, stats: db.stats }, { services });
    try {
      const socket = await openChat(id, app);
      await waitFor(() => socket.all().some((m) => m.id === `m_after${id.slice(0, 4)}`), "the later message");
      const ids = socket.all().map((m) => m.id);
      expect(ids.filter((m) => m === `m_before${id.slice(0, 4)}`)).toHaveLength(1);
      expect(ids.filter((m) => m === `m_after${id.slice(0, 4)}`)).toHaveLength(1);
      await waitFor(() => socket.all().some((m) => m.id === "req_email_1"), "the card");
      await new Promise((resolve) => setTimeout(resolve, 100)); // room for a duplicate to arrive
      expect(socket.all().filter((m) => m.id === "req_email_1")).toHaveLength(1);
      expect(beforeSync(socket.all()).map((m) => m.id)).toContain(`m_before${id.slice(0, 4)}`); // replayed
      expect(afterSync(socket.all()).map((m) => m.id)).toContain(`m_after${id.slice(0, 4)}`); // live, after syncDone
      // The thread order is the commit order: the card is not replayed ahead of the message committed before it.
      expect(beforeSync(socket.all()).map((m) => m.id)).not.toContain("req_email_1");
      const live = afterSync(socket.all()).map((m) => m.id);
      expect(live.indexOf(`m_after${id.slice(0, 4)}`)).toBeLessThan(live.indexOf("req_email_1"));
      socket.ws.close();
    } finally {
      await app.close();
    }
  });

  it("a replay that fails closes 1011 (the client retries) and leaves no listener behind", async () => {
    const id = await seedSession(db.pool);
    const failing = hookPool(db.pool, async (text, _values, phase) => {
      if (phase === "before" && text.startsWith(REPLAY_BEGIN)) throw Object.assign(new Error("connection lost"), { code: "57P01" });
    });
    const app = await startApp({ pool: failing, stats: db.stats }, { services });
    try {
      const socket = connect(`${app.ws}/chat?sessionId=${id}`);
      expect(await socket.closed).toEqual({ code: 1011, reason: "server error" });
      expect(socket.messages).toEqual([{ type: "closing", code: 1011, reason: "server error" }]);
      await waitFor(() => services.hub.listenerCount(id) === 0, "listener cleanup");
    } finally {
      await app.close();
    }
  });

  it("doesn't re-send a buffered event that the replay already reflects (an inputError before lastSeq stays unsent)", async () => {
    const id = await seedSession(db.pool);
    await run(id, { type: "Test.OpenCard", requestId: "req_serialNumber_1", field: "serialNumber" });
    // A rejection commits after the socket subscribed but before the replay reads lastSeq: the replay's open card is
    // already "after" it, and the buffered inputError is older than the replay, so it must not reach the client.
    let armed = true;
    const hooked = hookPool(db.pool, async (text, _values, phase) => {
      if (!armed || phase !== "before" || !text.startsWith(REPLAY_BEGIN)) return;
      armed = false;
      await run(id, { type: "Test.Reject", requestId: "req_serialNumber_1" });
    });
    const app = await startApp({ pool: hooked, stats: db.stats }, { services });
    try {
      const socket = await openChat(id, app);
      await run(id, { type: "Test.Say", messageId: `s${id.slice(0, 6)}`, text: "a later message" }); // proves the stream is live
      await waitFor(() => socket.all().some((m) => m.id === `m_s${id.slice(0, 6)}`), "the later message");
      expect(socket.all().filter((m) => m.type === "inputError")).toEqual([]);
      expect(socket.all().filter((m) => m.id === "req_serialNumber_1")).toHaveLength(1);
      socket.ws.close();
    } finally {
      await app.close();
    }
  });

  it("a connect is not user activity: it writes nothing and moves no timer", async () => {
    const id = await seedSession(db.pool);
    await run(id, { type: "Test.Activity" });
    const before = await getSession(db.pool, id);
    const timers = await listTimers(db.pool, id);
    const socket = await openChat(id);
    socket.ws.close();
    await openChat(id).then((again) => again.ws.close());
    expect(await getSession(db.pool, id)).toEqual(before);
    expect(await listTimers(db.pool, id)).toEqual(timers);
  });
});

describe("live fan-out", () => {
  it("two tabs receive identical, ordered streams; listeners are removed when the sockets close", async () => {
    const id = await seedSession(db.pool);
    const a = await openChat(id);
    const b = await openChat(id);
    expect(services.hub.listenerCount(id)).toBe(2);
    for (let i = 1; i <= 10; i++) await run(id, { type: "Test.Say", messageId: `t${i}x${id.slice(0, 6)}`, text: `message ${i}` });
    await waitFor(() => afterSync(a.all()).length >= 10 && afterSync(b.all()).length >= 10, "10 messages on both");
    expect(afterSync(a.all())).toEqual(afterSync(b.all()));
    expect(afterSync(a.all()).map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${i + 1}`));
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    await waitFor(() => services.hub.listenerCount(id) === 0, "listener cleanup");
  });

  it("sends sessionState when what the client sees changes (a call starts and ends), not on every command", async () => {
    const id = await seedSession(db.pool);
    const callId = `c${id.slice(0, 8)}`;
    await seedCall(db, id, callId);
    const socket = await openChat(id);
    await run(id, { type: "Test.Append", n: 1 });
    await run(id, { type: "Test.StartCall", callId });
    await run(id, { type: "Test.Append", n: 2 });
    await run(id, { type: "Test.EndCall" });
    await waitFor(() => afterSync(socket.all()).length >= 2, "two state changes");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(afterSync(socket.all()).map((m) => [m.type, m.callActive])).toEqual([
      ["sessionState", true],
      ["sessionState", false],
    ]);
    socket.ws.close();
  });
});

describe("inbound messages (zod, protocol.md §3.4)", () => {
  it("answers an inputResponse to a request that isn't open with inputError, and stays open", async () => {
    const id = await seedSession(db.pool);
    const socket = await openChat(id);
    socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: "req_email_1", field: "email", value: "a@b.co" }));
    await waitFor(() => socket.all().some((m) => m.type === "inputError"), "inputError");
    expect(socket.all().at(-1)).toEqual({ type: "inputError", id: "err_req_email_1_0", requestId: "req_email_1", message: "This request is no longer active." });
    socket.ws.close();
  });

  // optOut was accepted silently here until P4-T05 gave it a handler: it now opens "Stop your claim?" (covered in
  // scenarios/chatOnly.test.ts), so it left this list of messages that get no answer.
  it("drops invalid, oversized-value and unknown messages without answering; clientMetric is accepted silently", async () => {
    const id = await seedSession(db.pool);
    const socket = await openChat(id);
    const count = socket.all().length;
    for (const bad of [
      { type: "inputResponse", requestId: "r", field: "f", value: "x".repeat(1001) },
      { type: "inputResponse", requestId: "r", field: "f", value: { nested: true } },
      { type: "inputResponse", requestId: "", field: "f", value: "x" },
      { type: "clientMetric", name: "turnLatency", turnId: "ta_c_1", ms: 60_001, at: "now" },
      { type: "unknownType" },
      [1, 2, 3],
    ]) {
      socket.ws.send(JSON.stringify(bad));
    }
    socket.ws.send(JSON.stringify({ type: "clientMetric", name: "turnLatency", turnId: "ta_c_1", ms: 1384, at: "2026-11-07T10:02:14.512+05:30" }));
    socket.ws.send(Buffer.from([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.all()).toHaveLength(count);
    expect(socket.ws.readyState).toBe(socket.ws.OPEN);
    socket.ws.close();
  });
});

/** A pool whose query() calls a hook before and after each statement (statements via connect() are not hooked). */
/** Runs `hook` around every query, on the pool and on clients checked out of it (transactions). */
function hookPool(pool: pg.Pool, hook: (text: string, values: unknown[] | undefined, phase: "before" | "after") => Promise<void>): pg.Pool {
  const hooked = <T extends object>(target: T, wrapConnect: boolean): T =>
    new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (property === "query") {
          return async (text: string, values?: unknown[]) => {
            await hook(text, values, "before");
            const result = await (value as (t: string, v?: unknown[]) => Promise<unknown>).call(inner, text, values);
            await hook(text, values, "after");
            return result;
          };
        }
        if (wrapConnect && property === "connect") {
          return async () => hooked(await (inner as unknown as pg.Pool).connect(), false);
        }
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return hooked(pool, true);
}
