// Idempotent delivery end to end (P7-T02..T04): a real commit nudges the worker, which POSTs to this server's own stub
// receiver; the receiver ends up with exactly one row per (session, revision), also when a delivery is repeated, and a
// rejected delivery is visible in the session's timeline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret } from "../../src/config.js";
import { OutboxWorker } from "../../src/delivery/worker.js";
import type { Database } from "../../src/db/pool.js";
import { listOutbox, saveOutbox } from "../../src/db/repos/outbox.js";
import { listReceivedRecords } from "../../src/db/repos/receivedRecords.js";
import { upsertTimer } from "../../src/db/repos/timers.js";
import { createLogger } from "../../src/log.js";
import type { SessionServices } from "../../src/session/services.js";
import { FAKE } from "../fixtures.js";
import { type RunningApp, startApp } from "../helpers/app.js";
import { answerOpen, ANSWERS, openCard, answer, sessionAtField, storeTestFile } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { sleep } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;
let worker: OutboxWorker;

const hookSecret = new Secret(FAKE.HOOK_SECRET);
const testApiToken = new Secret(FAKE.TEST_API_TOKEN);

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("e2edelivery", { max: 12 }));
  services = testServices(db, { planner: true, onOutboxQueued: () => worker?.notify() });
  server = await startApp(db, { services, hookSecret, testApiToken });
  worker = new OutboxWorker({ pool: db.pool, log: createLogger("silent"), url: new Secret(`${server.http}/hooks/records`), hookSecret, backoff: { baseMs: 15, capMs: 60 } });
  await worker.start();
});
afterAll(async () => {
  await worker.stop();
  await server.close();
  await schema.drop();
});

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const received = async (id: string) => (await listReceivedRecords(db.pool)).filter((r) => r.idempotencyKey.startsWith(id));
const idle = async (id: string) => {
  await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: new Date(Date.now() - 1000) });
  await services.processor.dispatch(id, { type: "TimerFired", kind: "idle", dueAt: new Date() } as never);
};

describe("from commit to the receiver", () => {
  it("revision 1 (partial) and then revision 2 (completed) each reach the receiver once, in order", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    await until(async () => (await received(id)).length === 1, "revision 1 at the receiver"); // nudged, no polling
    expect((await received(id))[0]).toMatchObject({ idempotencyKey: `${id}:1`, timesReceived: 1, payload: { outcome: "partial", revision: 1 } });

    await answerOpen(db, services, id, "email", ANSWERS.email);
    for (let i = 0; i < 4; i++) {
      const open = await openCard(db, id);
      if (!open || open.field === "submitConfirmation") break;
      await answer(services, id, open.id, open.field, open.field === "purchaseInvoice" ? `file:${(await storeTestFile(db, id)).id}` : ANSWERS[open.field]);
    }
    await answerOpen(db, services, id, "submitConfirmation", true);
    await until(async () => (await received(id)).length === 2, "revision 2 at the receiver");
    const rows = await received(id);
    expect(rows.map((r) => [r.idempotencyKey, r.timesReceived])).toEqual([[`${id}:1`, 1], [`${id}:2`, 1]]);
    expect(rows[1]?.payload).toMatchObject({ outcome: "completed", previousRevision: { revision: 1, outcome: "partial" } });
    expect(rows[0]?.firstReceivedAt.getTime()).toBeLessThanOrEqual(rows[1]?.firstReceivedAt.getTime() ?? 0);
    await until(async () => (await listOutbox(db.pool, id)).every((o) => o.status === "delivered"), "both marked delivered");
  });

  it("a delivery repeated after a crash (received but not marked) is stored once: times_received 2, still one row", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    await until(async () => (await listOutbox(db.pool, id))[0]?.status === "delivered", "delivered");
    const [row] = await listOutbox(db.pool, id);
    // As if the process died between the receiver's 200 and the bookkeeping.
    await saveOutbox(db.pool, { id: row?.id ?? 0, status: "pending", attempts: 1, nextAttemptAt: new Date(), lastError: null, deliveredAt: null });
    worker.notify();
    await until(async () => (await received(id))[0]?.timesReceived === 2, "the repeat");
    expect(await received(id)).toHaveLength(1);
    await until(async () => (await listOutbox(db.pool, id))[0]?.status === "delivered", "delivered again");
  });

  it("a delivery the receiver rejects is dead, and the timeline shows it with its error", async () => {
    const id = await sessionAtField(db, services, "email");
    const wrong = new OutboxWorker({ pool: db.pool, log: createLogger("silent"), url: new Secret(`${server.http}/hooks/records`), hookSecret: new Secret("not-the-hook-secret-0000000000000000"), backoff: { baseMs: 15, capMs: 60 } });
    await worker.stop(); // only the misconfigured worker handles this row
    await idle(id);
    await wrong.start();
    await until(async () => (await listOutbox(db.pool, id))[0]?.status === "dead", "dead");
    await wrong.stop();
    expect(await received(id)).toEqual([]);
    const timeline = (await (await fetch(`${server.http}/api/sessions/${id}/timeline`)).json()) as { deliveries: unknown[] };
    expect(timeline.deliveries).toEqual([expect.objectContaining({ revision: 1, target: "webhook", status: "dead", attempts: 1, lastError: "HTTP 401", nextAttemptAt: null, deliveredAt: null })]);
    await worker.start();
  });
});
