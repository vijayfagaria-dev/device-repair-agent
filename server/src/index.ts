// Server entry point: validate config, build the app, listen, and shut down cleanly on SIGTERM/SIGINT.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp, fileUrlSigner, settleCalls } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { migrateAtBoot } from "./db/migrate.js";
import { createDatabase } from "./db/pool.js";
import { recoverOnBoot } from "./boot/recover.js";
import { createShutdown, installSignalHandlers } from "./boot/shutdown.js";
import { Secret } from "./config.js";
import { OutboxWorker } from "./delivery/worker.js";
import { Sweeper } from "./jobs/sweeper.js";
import { QuotaGuard } from "./limits/quotaGuard.js";
import { createLogger } from "./log.js";
import { createLlmRouter, llmHops } from "./agent/llm.js";
import { createDeepgramStt } from "./voice/deepgram.js";
import { createDeepgramTts } from "./voice/deepgramTts.js";
import { createSessionServices } from "./session/services.js";

const WEB_DIST_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Names and expectations only; ConfigError never contains a value.
    createLogger("info").fatal({ problems: err.problems }, err.message);
    process.exit(1);
  }

  const log = createLogger(config.logLevel);
  const db = createDatabase({
    connectionString: config.databaseUrl.reveal(),
    onError: (err) => log.error({ code: (err as { code?: string }).code, message: err.message }, "idle database connection failed"),
  });
  try {
    const { applied } = await migrateAtBoot(db.pool, log);
    log.info({ applied, count: applied.length }, "migrations complete");
  } catch (err) {
    await db.pool.end().catch(() => {});
    throw err;
  }

  const files = { fileUrlSecret: config.fileUrlSecret, fileUrlTtlSeconds: config.fileUrlTtlSeconds, publicOrigin: config.publicOrigin };
  const services = createSessionServices({
    pool: db.pool,
    log,
    timers: { idleTimeoutMs: config.idleTimeoutSeconds * 1000, sessionLifetimeMs: config.sessionLifetimeSeconds * 1000 },
    signFileUrl: fileUrlSigner(files)?.sign,
    autoCompleteOnIdle: config.autoCompleteOnIdle,
  });
  const sweeper = new Sweeper({ pool: db.pool, processor: services.processor, log: log.child({ component: "sweeper" }) });
  services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
  // The call's providers (P5): Deepgram STT and Aura-2 over WebSockets, the LLM through the fallback chain (D06).
  const stt = createDeepgramStt({ apiKey: config.deepgramApiKey });
  const tts = createDeepgramTts({ apiKey: config.deepgramApiKey, voice: config.ttsVoice });
  const llm = createLlmRouter({
    hops: llmHops({ groqApiKey: config.groqApiKey, geminiApiKey: config.geminiApiKey, models: config.llmRoutes }),
    onHopFailed: (route, error) => log.warn({ provider: route.provider, model: route.model, status: error.status }, "LLM route failed; trying the next"),
  });

  const quota = new QuotaGuard(
    db.pool,
    {
      llmRequestsPerDay: config.dailyLlmRequestBudget,
      audioMinutesPerDay: config.dailyAudioMinutesBudget,
      overrideToken: config.quotaOverrideToken,
    },
    log.child({ component: "quota" }),
  );
  const app = await buildApp({
    quota,
    voice: { providers: () => ({ stt, tts, llm }), maxConcurrentCalls: config.maxConcurrentCalls, timings: { maxCallMs: config.maxCallSeconds * 1000 }, quota },
    logger: log,
    services,
    db,
    webDistDir: WEB_DIST_DIR,
    requireWebBuild: config.env === "production",
    trustProxyHops: config.trustProxyHops,
    newSessionsPerIpPerHour: config.newSessionsPerIpPerHour,
    testApiToken: config.testApiToken,
    hookSecret: config.hookSecret,
    ...files,
    uploadBudgetBytes: config.uploadBudgetBytes,
  });
  // Signals are handled from here on, also while recovering and in the moment between listen and the outbox worker.
  let outbox: OutboxWorker | null = null;
  installSignalHandlers(
    createShutdown({
      log,
      closeServer: () => app.close(),
      settleCalls: () => settleCalls(app),
      stopSweeper: () => sweeper.stop(),
      drainCommands: (ms) => services.processor.drain(ms),
      stopOutbox: async () => {
        await outbox?.stop();
      },
      pool: db.pool,
    }),
  );

  // Boot recovery (P8-T01) runs before the server listens: dangling calls, overdue timers (the sweeper starts here),
  // reconciliation of every active session, orphaned uploads. The outbox worker starts after listen: its default
  // target is this very server.
  await recoverOnBoot({ pool: db.pool, processor: services.processor, sweeper, log });
  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as AddressInfo).port; // the real port (PORT=0 picks one)
  const webhookUrl = config.recordWebhookUrl ?? new Secret(`http://127.0.0.1:${port}/hooks/records`);
  outbox = new OutboxWorker({ pool: db.pool, log: log.child({ component: "outbox" }), url: webhookUrl, hookSecret: config.hookSecret });
  services.processor.onOutboxQueued = () => outbox?.notify();
  await outbox.start();
}

main().catch((err: unknown) => {
  createLogger("info").fatal({ err }, "server failed to start");
  process.exit(1);
});
