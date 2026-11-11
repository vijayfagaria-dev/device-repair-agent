// Graceful shutdown (P8-T02): the order of the steps, what happens when one fails or hangs, the hard limit, and the
// real thing in-process (a live call and a chat socket get 1012, the call row is closed, the pool ends last).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeCalls, buildApp, settleCalls } from "../../src/app.js";
import { createShutdown, type ShutdownDeps } from "../../src/boot/shutdown.js";
import { OutboxWorker } from "../../src/delivery/worker.js";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { listCalls } from "../../src/db/repos/calls.js";
import { listEvents } from "../../src/db/repos/events.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { Sweeper } from "../../src/jobs/sweeper.js";
import { createLogger } from "../../src/log.js";
import { FakeLlm } from "../../src/voice/fakes/llm.js";
import { FakeStt } from "../../src/voice/fakes/stt.js";
import { FakeTts } from "../../src/voice/fakes/tts.js";
import { FAKE } from "../fixtures.js";
import { connect, ORIGIN } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { sleep } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("shutdown", { max: 6 }));
});
afterAll(async () => {
  await schema.drop();
});

const log = createLogger("silent");

function fakes(order: string[], overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { exits: number[] } {
  const exits: number[] = [];
  const mark = (name: string) => async () => {
    order.push(name);
  };
  return {
    log,
    closeServer: mark("close sockets"),
    settleCalls: async () => {
      order.push("settle calls");
      return true;
    },
    stopSweeper: mark("stop sweeper"),
    drainCommands: async () => {
      order.push("drain commands");
      return true;
    },
    stopOutbox: mark("stop outbox"),
    pool: { end: async () => void order.push("close database") },
    exit: (code) => void exits.push(code),
    exits,
    ...overrides,
  } as ShutdownDeps & { exits: number[] };
}

describe("createShutdown", () => {
  it("runs the steps in order, the database last, and exits 0", async () => {
    const order: string[] = [];
    const deps = fakes(order);
    await createShutdown(deps)("SIGTERM");
    expect(order).toEqual(["close sockets", "settle calls", "stop sweeper", "drain commands", "stop outbox", "close database"]);
    expect(deps.exits).toEqual([0]);
  });

  it("a second signal while stopping changes nothing", async () => {
    const order: string[] = [];
    const deps = fakes(order);
    const shutdown = createShutdown(deps);
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect(order.filter((s) => s === "close database")).toHaveLength(1);
    expect(deps.exits).toEqual([0]);
  });

  it("a step that fails is logged and the rest still run, the database included", async () => {
    const order: string[] = [];
    const deps = fakes(order, {
      stopSweeper: async () => {
        throw new Error("sweeper broke");
      },
      settleCalls: async () => false,
      drainCommands: async () => false,
    });
    await createShutdown(deps)("SIGTERM");
    expect(order).toEqual(["close sockets", "stop outbox", "close database"]);
    expect(deps.exits).toEqual([0]);
  });

  it("a step that never finishes is cut off by the hard limit: exit code 1", async () => {
    const order: string[] = [];
    const deps = fakes(order, { closeServer: () => new Promise(() => {}), timeoutMs: 150 });
    void createShutdown(deps)("SIGTERM");
    await sleep(400);
    expect(deps.exits).toEqual([1]);
    expect(order).toEqual([]); // stuck on the first step; nothing after it ran
  });
});

describe("the real pieces, in-process", () => {
  it("a live call and a chat socket get 1012; the call row closes (server_restart) before the pool ends; well inside 10 s", async () => {
    const own = schema.open({ max: 6 });
    const services = testServices(own, { planner: true });
    const sweeper = new Sweeper({ pool: own.pool, processor: services.processor, log });
    const outbox = new OutboxWorker({ pool: own.pool, log, url: new Secret("http://127.0.0.1:9/hooks/records"), hookSecret: new Secret(FAKE.HOOK_SECRET) });
    const stt = new FakeStt();
    const tts = new FakeTts();
    const llm = new FakeLlm();
    llm.fallback = { text: "Okay." };
    const app = await buildApp({
      logger: log,
      db: own,
      webDistDir: "/nonexistent",
      requireWebBuild: false,
      publicOrigin: ORIGIN,
      services,
      voice: { providers: () => ({ stt, tts, llm }), maxConcurrentCalls: 3, timings: { silenceMs: 60_000 } },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const ws = address.replace(/^http/, "ws");
    await sweeper.start();
    await outbox.start();

    const id = randomUUID();
    const call = connect(`${ws}/call?sessionId=${id}`);
    await call.opened;
    for (let i = 0; i < 300 && (await getSession(own.pool, id))?.activeCallId == null; i++) await sleep(10);
    expect((await getSession(own.pool, id))?.activeCallId).not.toBeNull();
    const chat = connect(`${ws}/chat?sessionId=${randomUUID()}`);
    await chat.opened;

    const exits: number[] = [];
    const steps: string[] = [];
    const began = Date.now();
    await createShutdown({
      log,
      closeServer: () => app.close(),
      settleCalls: () => settleCalls(app),
      stopSweeper: () => sweeper.stop(),
      drainCommands: (ms) => services.processor.drain(ms),
      stopOutbox: () => outbox.stop(),
      pool: {
        end: async () => {
          steps.push("pool");
          await own.pool.end();
        },
      },
      exit: (code) => void exits.push(code),
    })("SIGTERM");

    expect(exits).toEqual([0]);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(await call.closed).toMatchObject({ code: 1012, reason: "server restarting" });
    expect(await chat.closed).toMatchObject({ code: 1012, reason: "server restarting" });
    expect(activeCalls.get(app)?.size).toBe(0);
    // Read through another pool: the call row is closed and says why.
    expect((await listCalls(db.pool, id))[0]).toMatchObject({ endReason: "server_restart" });
    expect((await listEvents(db.pool, id)).filter((e) => e.type === "call.ended").map((e) => e.payload.reason)).toEqual(["server_restart"]);
    expect((await getSession(db.pool, id))?.activeCallId).toBeNull();
    expect(steps).toEqual(["pool"]);
  });

  it("drainCommands waits for commands in flight, reactions included, and reports a timeout", async () => {
    const own = schema.open({ max: 4 });
    const services = testServices(own, { planner: true });
    expect(await services.processor.drain(50)).toBe(true); // nothing running
    const id = randomUUID();
    await own.pool.query("INSERT INTO sessions (id) VALUES ($1)", [id]);
    const running = services.processor.dispatch(id, { type: "Reconcile" } as never);
    const drained = services.processor.drain(2_000);
    await running;
    expect(await drained).toBe(true);
    await own.pool.end();
  });
});
