// The E2E backend (P9-T02): the compiled server (server/dist) with fake providers on a throwaway schema, serving the built
// UI from web/dist, plus a tiny control API on another localhost port so a spec can script the fakes and read results.
// Plain Node (no TypeScript loader). It exists only for the E2E run: nothing in the shipped server starts it.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dist = (path) => import(new URL(`../../server/dist/${path}`, import.meta.url).href);
const { buildApp } = await dist("app.js");
const { Secret } = await dist("config.js");
const { migrate } = await dist("db/migrate.js");
const { createDatabase } = await dist("db/pool.js");
const { createFileUrlSigner } = await dist("files/signing.js");
const { createLogger } = await dist("log.js");
const { createSessionServices } = await dist("session/services.js");
const { FakeLlm } = await dist("voice/fakes/llm.js");
const { FakeStt } = await dist("voice/fakes/stt.js");
const { FakeTts } = await dist("voice/fakes/tts.js");
const { Sweeper } = await dist("jobs/sweeper.js");
const { upsertTimer } = await dist("db/repos/timers.js");
const { listRecords } = await dist("db/repos/records.js");
const { getSession } = await dist("db/repos/sessions.js");

const base = process.env.E2E_DATABASE_URL;
if (!base) throw new Error("E2E_DATABASE_URL is not set");
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const schema = `e2e_${randomBytes(6).toString("hex")}`;
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();
const dbUrl = new URL(base);
dbUrl.searchParams.set("options", `-c search_path=${schema}`);
const db = createDatabase({ connectionString: dbUrl.toString(), onError: () => {}, max: 8 });
await migrate(db.pool);

const port = await freePort();
const origin = `http://127.0.0.1:${port}`; // the page's own origin: the sockets check it
const fileSecret = new Secret(randomBytes(32).toString("hex"));
const logger = createLogger("silent");
const services = createSessionServices({ pool: db.pool, log: logger, signFileUrl: createFileUrlSigner({ secret: fileSecret, publicOrigin: origin }).sign, planner: true });

const fakes = {};
const fresh = () => {
  fakes.stt = new FakeStt();
  fakes.tts = new FakeTts();
  fakes.llm = new FakeLlm();
  fakes.llm.fallback = { text: "Okay." };
};
fresh();

const app = await buildApp({
  logger,
  db,
  webDistDir: webDist,
  requireWebBuild: true,
  publicOrigin: origin,
  services,
  fileUrlSecret: fileSecret,
  uploadsPerMinute: 1000,
  newSessionsPerIpPerHour: 10_000,
  noCallStartMs: 400, // a page with no call starts its chat quickly
  voice: { providers: () => ({ stt: fakes.stt, tts: fakes.tts, llm: fakes.llm }), maxConcurrentCalls: 2, timings: { silenceMs: 120_000 } },
});
await app.listen({ host: "127.0.0.1", port });
// The real sweeper: a page with no call gets its chat when the noCallStart timer fires (PD10).
const sweeper = new Sweeper({ pool: db.pool, processor: services.processor, log: logger });
services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
await sweeper.start();

// ---- the control API (localhost only) -----------------------------------------------------------------------------
const readJson = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}));
  });

const control = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? {}));
  };
  try {
    const body = request.method === "POST" ? await readJson(request) : {};
    switch (`${request.method} ${url.pathname}`) {
      case "POST /fresh":
        fresh();
        return send(200);
      case "POST /llm":
        fakes.llm.enqueue(...body.scripts);
        return send(200);
      case "POST /stt/say":
        fakes.stt.current.say(body.text);
        return send(200);
      case "POST /stt/interim":
        fakes.stt.current.emit({ type: "speechStarted" });
        fakes.stt.current.emit({ type: "transcript", text: body.text, isFinal: false, speechFinal: false });
        return send(200);
      case "GET /stats":
        return send(200, {
          sttStreams: fakes.stt.streams.length,
          sttBytes: fakes.stt.streams.at(-1)?.bytes ?? 0,
          ttsStreams: fakes.tts.streams.length,
          llmQueued: fakes.llm.queued,
          llmRequests: fakes.llm.requests.length,
        });
      case "POST /timer": {
        await upsertTimer(db.pool, { sessionId: body.sessionId, kind: body.kind, dueAt: new Date(Date.now() - 1000) });
        const { reply } = await services.processor.dispatch(body.sessionId, { type: "TimerFired", kind: body.kind, dueAt: new Date() });
        return send(200, reply);
      }
      case "GET /records": {
        const records = await listRecords(db.pool, url.searchParams.get("sessionId"));
        return send(200, records.map((r) => ({ revision: r.revision, outcome: r.outcome, payload: r.payload })));
      }
      case "GET /session":
        return send(200, await getSession(db.pool, url.searchParams.get("sessionId")));
      default:
        return send(404, { error: "no such control" });
    }
  } catch (err) {
    send(500, { error: String(err?.message ?? err) });
  }
});
const controlPort = await freePort();
await new Promise((resolve) => control.listen(controlPort, "127.0.0.1", resolve));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => control.close(resolve));
  await sweeper.stop();
  await app.close();
  await db.pool.end().catch(() => {});
  const cleanup = new pg.Client({ connectionString: base });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
  await cleanup.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

console.log(`READY ${JSON.stringify({ origin, control: `http://127.0.0.1:${controlPort}` })}`);
