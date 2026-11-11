// The outbox worker (P7-T03) against a local HTTP receiver whose behaviour each test scripts: retries with backoff,
// per-session revision order, dead-lettering, leases, two workers, restart pickup, and the headers it sends.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Secret } from "../../src/config.js";
import { OutboxWorker, type OutboxWorkerOptions } from "../../src/delivery/worker.js";
import type { Database } from "../../src/db/pool.js";
import { insertOutbox, listOutbox, saveOutbox } from "../../src/db/repos/outbox.js";
import { insertRecord } from "../../src/db/repos/records.js";
import { buildRecord } from "../../src/domain/record.js";
import { createLogger } from "../../src/log.js";
import { SCENARIOS } from "../domain/scenarios.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession, sleep } from "../helpers/seed.js";

let schema: TestSchema;
let db: Database;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("worker", { max: 10 }));
});
afterAll(async () => {
  await schema.drop();
});

const HOOK_SECRET = new Secret("hook-secret-for-the-worker-test-000000");

interface Received {
  key: string | undefined;
  secret: string | undefined;
  contentType: string | undefined;
  body: { sessionId: string; revision: number };
  at: number;
}

/** A receiver that answers each request with whatever `respond` says (a status, "hang", or "drop"). */
async function receiver(respond: (received: Received, index: number) => number | "hang" | "drop" | { redirect: string }): Promise<{ url: Secret; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const item: Received = {
        key: request.headers["idempotency-key"] as string | undefined,
        secret: request.headers["x-hook-secret"] as string | undefined,
        contentType: request.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        at: Date.now(),
      };
      received.push(item);
      const verdict = respond(item, received.length - 1);
      if (verdict === "hang") return; // never answers: the worker's timeout fires
      if (verdict === "drop") {
        request.socket.destroy();
        return;
      }
      if (typeof verdict === "object") {
        response.writeHead(302, { location: verdict.redirect });
        response.end();
        return;
      }
      response.writeHead(verdict).end("{}");
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new Secret(`http://127.0.0.1:${port}/hooks/records`),
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A session with `revisions` real, valid records and a pending outbox row for each. */
async function sessionWithDeliveries(revisions: number): Promise<string> {
  const id = await seedSession(db.pool);
  const names = ["partial", "completed", "needsReview", "optedOut"] as const;
  for (let revision = 1; revision <= revisions; revision++) {
    const { record } = buildRecord({ ...SCENARIOS[names[revision - 1] ?? "partial"](), sessionId: id, revision });
    await insertRecord(db.pool, { sessionId: id, revision, outcome: record.outcome, payload: record as never, contentHash: String(revision).repeat(64) });
    await insertOutbox(db.pool, { sessionId: id, revision, target: "webhook" });
  }
  return id;
}

const FAST = { backoff: { baseMs: 15, capMs: 60 }, random: () => 1 } as const;
const log = createLogger("silent");
const open: { stop(): Promise<void> }[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.stop()));
  await Promise.all(closers.splice(0).map((c) => c()));
});

function worker(url: Secret, options: Partial<OutboxWorkerOptions> = {}): OutboxWorker {
  const w = new OutboxWorker({ pool: db.pool, log, url, hookSecret: HOOK_SECRET, ...FAST, ...options });
  open.push(w);
  return w;
}
async function serve(respond: Parameters<typeof receiver>[0]) {
  const r = await receiver(respond);
  closers.push(r.close);
  return r;
}
async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const states = async (id: string) => (await listOutbox(db.pool, id)).map((o) => [o.revision, o.status, o.attempts]);

describe("delivery", () => {
  it("posts the stored record with the idempotency key and the hook secret, and marks it delivered", async () => {
    const id = await sessionWithDeliveries(1);
    const rx = await serve(() => 200);
    await worker(rx.url).start();
    expect(rx.received).toHaveLength(1);
    expect(rx.received[0]).toMatchObject({ key: `${id}:1`, secret: HOOK_SECRET.reveal(), contentType: "application/json", body: { sessionId: id, revision: 1 } });
    expect(await states(id)).toEqual([[1, "delivered", 1]]);
    expect((await listOutbox(db.pool, id))[0]?.deliveredAt).toBeInstanceOf(Date);
  });

  it("a flaky receiver (fail, fail, 200) is delivered on attempt 3, with growing waits", async () => {
    const id = await sessionWithDeliveries(1);
    const rx = await serve((_r, i) => (i < 2 ? 503 : 200));
    const w = worker(rx.url);
    await w.start();
    await until(async () => (await states(id))[0]?.[1] === "delivered", "delivery");
    expect(rx.received).toHaveLength(3);
    expect(await states(id)).toEqual([[1, "delivered", 3]]);
    const [a, b, c] = rx.received.map((r) => r.at);
    expect((b as number) - (a as number)).toBeGreaterThanOrEqual(14); // base 15 ms, full jitter (random = 1)
    expect((c as number) - (b as number)).toBeGreaterThanOrEqual(28); // doubled
  });

  it("rev 2 is never sent before rev 1 is done, even while rev 1 keeps failing", async () => {
    const id = await sessionWithDeliveries(2);
    let failing = true;
    const rx = await serve(() => (failing ? 500 : 200));
    const w = worker(rx.url);
    await w.start();
    await until(() => rx.received.length >= 3, "three failed attempts");
    expect(rx.received.every((r) => r.body.revision === 1)).toBe(true); // rev 2 waited
    failing = false;
    await until(async () => (await states(id)).every((s) => s[1] === "delivered"), "both delivered");
    expect(rx.received.map((r) => r.body.revision).slice(-2)).toEqual([1, 2]);
    const order = rx.received.map((r) => r.body.revision);
    expect(order.slice(order.indexOf(2)).every((r) => r === 2)).toBe(true); // no revision 1 after the first 2
  });

  it("a 4xx (not 408/429) is dead at once and releases the next revision; the error is kept, never the URL or secret", async () => {
    const id = await sessionWithDeliveries(2);
    const rx = await serve((r) => (r.body.revision === 1 ? 400 : 200));
    await worker(rx.url).start();
    await until(async () => (await states(id)).length === 2 && (await states(id))[1]?.[1] === "delivered", "rev 2 delivered");
    const [one, two] = await listOutbox(db.pool, id);
    expect([one?.status, one?.attempts, one?.lastError]).toEqual(["dead", 1, "HTTP 400"]);
    expect(two?.status).toBe("delivered");
    expect(JSON.stringify(await listOutbox(db.pool, id))).not.toMatch(/127\.0\.0\.1|hook-secret/);
  });

  it.each([408, 429, 500, 502])("HTTP %i is retried", async (status) => {
    const id = await sessionWithDeliveries(1);
    const rx = await serve((_r, i) => (i === 0 ? status : 200));
    await worker(rx.url).start();
    await until(async () => (await states(id))[0]?.[1] === "delivered", "delivery");
    expect(rx.received).toHaveLength(2);
  });

  it("gives up after the maximum attempts: dead, with the last error", async () => {
    const id = await sessionWithDeliveries(1);
    const rx = await serve(() => 500);
    await worker(rx.url, { maxAttempts: 3 }).start();
    await until(async () => (await states(id))[0]?.[1] === "dead", "dead");
    expect(rx.received).toHaveLength(3);
    expect(await states(id)).toEqual([[1, "dead", 3]]);
    expect((await listOutbox(db.pool, id))[0]?.lastError).toBe("HTTP 500");
  });

  it("a receiver that never answers times out and is retried; a dropped connection is a network error", async () => {
    const id = await sessionWithDeliveries(1);
    const rx = await serve((_r, i) => (i === 0 ? "hang" : i === 1 ? "drop" : 200));
    await worker(rx.url, { timeoutMs: 80 }).start();
    await until(async () => (await states(id))[0]?.[1] === "delivered", "delivery after a timeout and a drop");
    expect(rx.received).toHaveLength(3);
  });

  it("does not follow a redirect (the secret header would go along): it is a failure", async () => {
    const id = await sessionWithDeliveries(1);
    const target = await serve(() => 200);
    const rx = await serve(() => ({ redirect: target.url.reveal() }));
    await worker(rx.url, { maxAttempts: 2 }).start();
    await until(async () => (await states(id))[0]?.[1] === "dead", "dead");
    expect(target.received).toEqual([]);
    expect((await listOutbox(db.pool, id))[0]?.lastError).toBe("HTTP 302");
  });

  it("notify() delivers a new row at once; an idle worker does not poll", async () => {
    const rx = await serve(() => 200);
    const queries: string[] = [];
    const spied = new Proxy(db.pool, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === "query" || prop === "connect") && typeof value === "function") {
          return (...args: unknown[]) => {
            queries.push(String(prop));
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    const w = worker(rx.url, { pool: spied as never, maxSleepMs: 60_000 });
    await w.start();
    const idleQueries = queries.length;
    await sleep(300);
    expect(queries.length).toBe(idleQueries); // asleep: no timer, no polling
    const id = await sessionWithDeliveries(1);
    w.notify();
    await until(() => rx.received.length === 1, "the nudged delivery", 1500);
    expect(rx.received[0]?.body.sessionId).toBe(id);
  });

  it("a stop leaves unfinished rows, and the next start (a restart) delivers them", async () => {
    const id = await sessionWithDeliveries(2);
    const rx = await serve(() => 200);
    const first = worker(rx.url);
    await first.stop(); // never started: nothing delivered
    expect(await states(id)).toEqual([[1, "pending", 0], [2, "pending", 0]]);
    await worker(rx.url).start();
    expect(await states(id)).toEqual([[1, "delivered", 1], [2, "delivered", 1]]);
    expect(rx.received.map((r) => r.body.revision)).toEqual([1, 2]);
  });

  it("a row leased by a worker that died is delivered again once the lease has passed; before that it is left alone", async () => {
    const id = await sessionWithDeliveries(2);
    const [one] = await listOutbox(db.pool, id);
    const lease = new Date(Date.now() + 300);
    await saveOutbox(db.pool, { id: one?.id ?? 0, status: "sending", attempts: 1, nextAttemptAt: lease, lastError: null, deliveredAt: null });
    const rx = await serve(() => 200);
    await worker(rx.url).start();
    expect(rx.received).toEqual([]); // leased (and rev 2 waits behind it)
    await until(async () => (await states(id)).every((s) => s[1] === "delivered"), "delivery after the lease");
    expect(rx.received.map((r) => r.body.revision)).toEqual([1, 2]);
    expect((await states(id))[0]?.[2]).toBe(2); // the dead worker's attempt counted
  });

  it("two workers (two instances) deliver every row exactly once", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => sessionWithDeliveries(1)));
    const rx = await serve(() => 200);
    const a = worker(rx.url);
    const b = worker(rx.url, { pool: schema.open({ max: 4 }).pool });
    await Promise.all([a.start(), b.start()]);
    await until(async () => (await Promise.all(ids.map(states))).every((s) => s[0]?.[1] === "delivered"), "all delivered");
    const keys = rx.received.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(12);
  });

  it("a session's revisions stay in order while two sessions are delivered in parallel", async () => {
    const a = await sessionWithDeliveries(3);
    const b = await sessionWithDeliveries(3);
    const rx = await serve(() => 200);
    await worker(rx.url).start();
    await until(async () => (await states(a)).every((s) => s[1] === "delivered") && (await states(b)).every((s) => s[1] === "delivered"), "all delivered");
    for (const id of [a, b]) expect(rx.received.filter((r) => r.body.sessionId === id).map((r) => r.body.revision)).toEqual([1, 2, 3]);
  });
});
