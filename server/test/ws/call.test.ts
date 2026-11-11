// WS /call (P5-T02, P5-T09, P5-T12) over real sockets and the throwaway test Postgres, with fake providers: every way
// a call ends gives exactly one call.ended with the right reason; the refusals; frame validation; the hand-off to
// chat after a hang-up within 1 s; a returning call; spoken fields stored through the real commands.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listCalls } from "../../src/db/repos/calls.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { listInputRequests } from "../../src/db/repos/inputRequests.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTranscriptLines } from "../../src/db/repos/transcriptLines.js";
import type { SessionServices } from "../../src/session/services.js";
import type { VoiceDeps } from "../../src/ws/call.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { connect, type RunningApp, startApp, type TestSocket } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;
let stt: FakeStt;
let tts: FakeTts;
let llm: FakeLlm;
const voice: VoiceDeps = {
  providers: () => ({ stt, tts, llm }),
  maxConcurrentCalls: 5,
  timings: { silenceMs: 60_000 },
};

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("callsock", { max: 10 }));
  services = testServices(db, { planner: true });
  server = await startApp(db, { services, voice });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

function fresh(): void {
  stt = new FakeStt();
  tts = new FakeTts();
  llm = new FakeLlm();
  llm.fallback = { text: "Okay." };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ended = async (id: string) => (await listEvents(db.pool, id)).filter((e) => e.type === "call.ended").map((e) => e.payload.reason);
const type = (m: unknown) => (m as { type: string }).type;

async function openCall(id: string, app = server, options: Parameters<typeof connect>[1] = {}): Promise<TestSocket> {
  const socket = connect(`${app.ws}/call?sessionId=${id}`, options);
  await socket.opened;
  return socket;
}

describe("starting a call", () => {
  it("creates the session lazily, starts the call once (call.started, a calls row, activeCallId) and greets", async () => {
    fresh();
    llm.enqueue({ text: "Hi, I'm Riya. What device is it?" });
    const id = randomUUID();
    const socket = await openCall(id);
    await waitFor(() => socket.messages.some((m) => type(m) === "transcript" && (m as { final: boolean }).final), "the greeting");
    expect(socket.messages.some((m) => type(m) === "audio")).toBe(true);
    const session = await getSession(db.pool, id);
    expect(session?.activeCallId).toMatch(/^c[A-Za-z0-9-]+$/);
    expect((await listCalls(db.pool, id)).map((c) => c.endedAt)).toEqual([null]);
    expect((await listEvents(db.pool, id)).map((e) => e.type).slice(0, 2)).toEqual(["session.created", "call.started"]);
    socket.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
  });

  it("a second call on the same session gets 4409; the first goes on", async () => {
    fresh();
    const id = await seedSession(db.pool);
    const first = await openCall(id);
    await waitFor(async () => (await getSession(db.pool, id))?.activeCallId !== null, "the first call");
    const second = await openCall(id);
    expect(await second.closed).toEqual({ code: 4409, reason: "call already active" });
    expect(first.ws.readyState).toBe(first.ws.OPEN);
    first.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
  });

  // Live report (2026-11-11): pressing Call while the same claim's call was still running said "Voice is busy right now",
  // because the capacity check (cap 1) ran before the per-session check.
  it("with a cap of 1, a second call from the same session is told a call is already active, not that voice is busy; the slot is free afterwards", async () => {
    fresh();
    const capped = await startApp(db, { services, voice: { ...voice, maxConcurrentCalls: 1 } });
    try {
      const id = await seedSession(db.pool);
      const first = await openCall(id, capped);
      await waitFor(async () => (await getSession(db.pool, id))?.activeCallId !== null, "the first call");
      const second = await openCall(id, capped);
      expect(await second.closed).toEqual({ code: 4409, reason: "call already active" });
      expect(first.ws.readyState).toBe(first.ws.OPEN);
      // Another session is still refused for capacity: the cap itself is unchanged.
      const other = await openCall(await seedSession(db.pool), capped);
      expect(await other.closed).toEqual({ code: 4429, reason: "capacity" });
      first.ws.close(1000);
      await first.closed;
      await waitFor(async () => (await ended(id)).length === 1, "call.ended");
      // The session's slot and the instance's slot are both free again.
      fresh();
      const again = await openCall(id, capped);
      await waitFor(async () => (await getSession(db.pool, id))?.activeCallId !== null, "the call to start again");
      expect(again.ws.readyState).toBe(again.ws.OPEN);
      again.ws.close(1000);
      await again.closed;
    } finally {
      await capped.close();
    }
  });

  it("P7-T05: calling on an opted-out session is refused with 4411 and the chat gets \"Resume your claim?\"; calling on a completed one reopens it", async () => {
    fresh();
    const optedOut = await seedSession(db.pool);
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'optedOut', current_revision = 1 WHERE id = $1", [optedOut]);
    expect(await (await openCall(optedOut)).closed).toEqual({ code: 4411, reason: "resume required" });
    expect((await listInputRequests(db.pool, optedOut)).map((r) => [r.field, r.status])).toEqual([["resumeConfirmation", "open"]]);
    expect((await getSession(db.pool, optedOut))?.status).toBe("finalized");
    expect(await ended(optedOut)).toEqual([]); // no call was ever started

    const completed = await seedSession(db.pool);
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'completed', current_revision = 1 WHERE id = $1", [completed]);
    const call = await openCall(completed);
    await waitFor(async () => (await getSession(db.pool, completed))?.activeCallId != null, "the call to start");
    expect(await getSession(db.pool, completed)).toMatchObject({ status: "active" });
    expect((await listEvents(db.pool, completed)).map((e) => e.type)).toEqual(expect.arrayContaining(["session.reopened", "call.started"]));
    call.ws.close(1000);
    await call.closed;
    await waitFor(async () => (await ended(completed)).length === 1, "the call to end");
  });

  it("refuses beyond the per-instance cap (4429 capacity), a closed session (4410), and without voice configured (1011)", async () => {
    fresh();
    const capped = await startApp(db, { services, voice: { ...voice, maxConcurrentCalls: 1 } });
    try {
      const a = await openCall(await seedSession(db.pool), capped);
      await waitFor(() => a.messages.length > 0, "the first call");
      const b = await openCall(await seedSession(db.pool), capped);
      expect(await b.closed).toEqual({ code: 4429, reason: "capacity" });
      a.ws.close(1000);
      await a.closed;
    } finally {
      await capped.close();
    }
    const closedId = await seedSession(db.pool);
    await db.pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [closedId]);
    expect(await (await openCall(closedId)).closed).toEqual({ code: 4410, reason: "session closed" });
    const noVoice = await startApp(db, { services });
    try {
      expect(await (await openCall(await seedSession(db.pool), noVoice)).closed).toEqual({ code: 1011, reason: "server error" });
    } finally {
      await noVoice.close();
    }
  });

  it("applies the same refusals as /chat (origin, session id), and a plain GET /call is the JSON 404", async () => {
    const foreign = connect(`${server.ws}/call?sessionId=${randomUUID()}`, { origin: "https://evil.example.com" });
    expect((await foreign.closed).code).toBe(4403);
    const bad = connect(`${server.ws}/call?sessionId=nope`);
    expect((await bad.closed).code).toBe(4400);
    const get = await fetch(`${server.http}/call`);
    expect(get.status).toBe(404);
  });
});

describe("mic frames", () => {
  it("640-byte binary frames go to STT; text and other sizes are dropped; over 4 KB closes 1009", async () => {
    fresh();
    const id = await seedSession(db.pool);
    const socket = await openCall(id);
    await waitFor(() => stt.streams.length === 1, "the STT stream");
    for (let i = 0; i < 10; i++) socket.ws.send(Buffer.alloc(640));
    socket.ws.send(Buffer.alloc(639));
    socket.ws.send("not audio");
    await waitFor(() => stt.current.bytes === 6400, "10 frames forwarded");
    socket.ws.send(Buffer.alloc(5000));
    expect((await socket.closed).code).toBe(1009);
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
  });
});

describe("every way a call ends: exactly one call.ended, with its reason", () => {
  async function endWith(action: (socket: TestSocket, id: string) => Promise<void>, app = server, options: Parameters<typeof connect>[1] = {}) {
    fresh();
    const id = await seedSession(db.pool);
    const socket = await openCall(id, app, options);
    await waitFor(async () => (await getSession(db.pool, id))?.activeCallId !== null, "call started");
    await waitFor(() => stt.streams.length === 1, "the providers open");
    await action(socket, id);
    await waitFor(async () => (await ended(id)).length >= 1, "call.ended");
    await new Promise((resolve) => setTimeout(resolve, 100)); // nothing more arrives
    const session = await getSession(db.pool, id);
    expect(session?.activeCallId).toBeNull();
    expect((await listCalls(db.pool, id)).every((c) => c.endedAt !== null)).toBe(true);
    return { id, reasons: await ended(id) };
  }

  it("hang-up (close 1000) → hangup; the tab closing (1001) → hangup", async () => {
    expect((await endWith(async (s) => s.ws.close(1000))).reasons).toEqual(["hangup"]);
    expect((await endWith(async (s) => s.ws.close(1001))).reasons).toEqual(["hangup"]);
  });

  it("network loss (pongs blocked: the keepalive terminates the socket) → network", async () => {
    const short = await startApp(db, { services, voice: { ...voice, keepAlive: { intervalMs: 50, maxMissed: 2 } } });
    try {
      expect((await endWith(async () => {}, short, { autoPong: false })).reasons).toEqual(["network"]);
    } finally {
      await short.close();
    }
  });

  it("server shutdown (SIGTERM: 1012) → server_restart", async () => {
    const doomed = await startApp(db, { services, voice });
    const result = await endWith(async () => {
      await doomed.close();
    }, doomed);
    expect(result.reasons).toEqual(["server_restart"]);
  });

  it("the maximum duration → max_duration, and the socket is closed 1000 'max duration'", async () => {
    const short = await startApp(db, { services, voice: { ...voice, timings: { ...voice.timings, maxCallMs: 300 } } });
    try {
      let close: unknown;
      const result = await endWith(async (s) => {
        close = await s.closed;
      }, short);
      expect(result.reasons).toEqual(["max_duration"]);
      expect(close).toEqual({ code: 1000, reason: "max duration" });
    } finally {
      await short.close();
    }
  });

  it("the agent ending it (end_call after its goodbye) → agent_ended, closed 'agent ended'", async () => {
    let close: unknown;
    const result = await endWith(async (s) => {
      llm.enqueue({ text: "Thanks, goodbye!", toolCalls: [{ name: "end_call", args: {} }] });
      stt.current.say("that's all thanks");
      close = await s.closed;
    });
    expect(result.reasons).toEqual(["agent_ended"]);
    expect(close).toEqual({ code: 1000, reason: "agent ended" });
  });
});

describe("hand-off to chat (P5-T09)", () => {
  it("a hang-up mid-way: the next missing field's card reaches the chat within 1 s", async () => {
    fresh();
    llm.enqueue({ text: "Hi! What device is it?" }, { toolCalls: [{ name: "save_field", args: { field: "deviceType", value: "smartphone", spoken_evidence: "a phone" } }] }, { text: "Which model?" });
    const id = await seedSession(db.pool);
    const chat = connect(`${server.ws}/chat?sessionId=${id}`);
    await chat.opened;
    const call = await openCall(id);
    await waitFor(() => stt.streams.length === 1, "STT");
    stt.current.say("It's a phone");
    await waitFor(async () => (await listFieldCandidates(db.pool, id, "deviceType")).length === 1, "deviceType saved");
    const hungUpAt = Date.now();
    call.ws.close(1000);
    await waitFor(() => chat.messages.some((m) => type(m) === "inputRequest"), "the chat card", 1_000);
    expect(Date.now() - hungUpAt).toBeLessThanOrEqual(1_000);
    const card = chat.messages.find((m) => type(m) === "inputRequest") as { field: string };
    expect(card.field).toBe("serialNumber"); // after a call: the chat fields first; deviceType isn't asked again
    expect((await listFieldCandidates(db.pool, id, "deviceType"))[0]).toMatchObject({ source: "call", status: "valid", normalized: "smartphone" });
    chat.ws.close();
  });

  it("the call's final lines are stored (both sides, in order); interim lines aren't", async () => {
    fresh();
    llm.enqueue({ text: "Hello, what device is it?" }, { text: "A laptop, got it." });
    const id = await seedSession(db.pool);
    const call = await openCall(id);
    await waitFor(() => stt.streams.length === 1, "STT");
    await waitFor(async () => (await listTranscriptLines(db.pool, id)).length === 1, "the greeting line");
    stt.current.say("It is a laptop");
    await waitFor(async () => (await listTranscriptLines(db.pool, id)).length === 3, "three lines");
    expect((await listTranscriptLines(db.pool, id)).map((l) => [l.role, l.text])).toEqual([
      ["agent", "Hello, what device is it?"],
      ["user", "It is a laptop"],
      ["agent", "A laptop, got it."],
    ]);
    call.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
  });
});

describe("a returning call (P5-T12)", () => {
  it("the second call is marked returning, and its first turn knows what's collected and the last question", async () => {
    fresh();
    llm.enqueue({ text: "Hi! And when did the problem start?" });
    const id = await seedSession(db.pool);
    await services.processor.dispatch(id, { type: "Test.Candidate", field: "deviceType", source: "call", raw: "x", normalized: "laptop", status: "valid" } as never);
    const first = await openCall(id);
    await waitFor(async () => (await listTranscriptLines(db.pool, id)).length === 1, "first call's greeting");
    first.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 1, "first call ended");

    fresh();
    llm.enqueue({ text: "Welcome back!" });
    const second = await openCall(id);
    await waitFor(() => llm.requests.length >= 1, "the second call's first turn");
    const messages = llm.requests[0]?.messages ?? [];
    expect(messages.find((m) => m.role === "user")).toEqual({ role: "user", content: "(The customer called back.)" });
    const state = JSON.parse(String(messages.at(-1)?.content).slice("STATE ".length));
    expect(state).toMatchObject({ isReturningCall: true, lastQuestionOnPreviousCall: "Hi! And when did the problem start?", collected: { deviceType: '<customer_words field="deviceType">Laptop</customer_words>' } });
    expect(state.missing).not.toContain("deviceType");
    expect((await listEvents(db.pool, id)).filter((e) => e.type === "call.started").map((e) => e.payload.returning)).toEqual([false, true]);
    second.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 2, "second call ended");
  });
});

describe("P5 review fixes (socket)", () => {
  it("#4 shutdown: settleCalls waits for EndCall to commit, even when a provider is slow to close", async () => {
    const { settleCalls } = await import("../../src/app.js");
    fresh();
    const doomed = await startApp(db, { services, voice });
    const id = await seedSession(db.pool);
    const socket = await openCall(id, doomed);
    await waitFor(() => stt.streams.length === 1, "STT");
    stt.current.closeDelayMs = 800;
    await doomed.close();
    expect(await settleCalls(doomed.app, 3_000)).toBe(true);
    expect(await ended(id)).toEqual(["server_restart"]);
    expect((await getSession(db.pool, id))?.activeCallId).toBeNull();
    void socket;
  });

  it("#12 mic frames faster than real time are dropped beyond a 2 s burst", async () => {
    fresh();
    const id = await seedSession(db.pool);
    const socket = await openCall(id);
    await waitFor(() => stt.streams.length === 1, "STT");
    for (let i = 0; i < 400; i++) socket.ws.send(Buffer.alloc(640)); // 8 s of audio at once
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frames = stt.current.bytes / 640;
    expect(frames).toBeGreaterThanOrEqual(100);
    expect(frames).toBeLessThan(130); // the burst, plus what refilled meanwhile
    socket.ws.close(1000);
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
  });
});

describe("a hang-up while the providers are still opening (found by the full-suite run)", () => {
  it("ends with reason hangup, not network", async () => {
    fresh();
    stt.openDelayMs = 400;
    const id = await seedSession(db.pool);
    const socket = await openCall(id);
    await waitFor(async () => (await getSession(db.pool, id))?.activeCallId !== null, "call started");
    socket.ws.close(1000); // before the STT has opened
    await waitFor(async () => (await ended(id)).length === 1, "call.ended");
    expect(await ended(id)).toEqual(["hangup"]);
  });
});
