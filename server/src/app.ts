// Builds the HTTP app without listening, so tests can drive it with `inject` (or listen on a free port for sockets).
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Secret } from "./config.js";
import type { Database } from "./db/pool.js";
import { createFileUrlSigner, type FileUrlSigner } from "./files/signing.js";
import { DEFAULT_UPLOAD_BUDGET_BYTES } from "./files/storage.js";
import { fileRoutes } from "./http/files.js";
import { quotaRoutes } from "./limits/routes.js";
import type { QuotaGuard } from "./limits/quotaGuard.js";
import { healthRoutes } from "./http/health.js";
import { hookRoutes } from "./http/hooks.js";
import { registerSecurityHeaders } from "./http/security.js";
import { sessionReadRoutes, testSessionRoutes } from "./http/sessions.js";
import { webRoutes } from "./http/web.js";
import { CreationLimiter } from "./session/creationLimit.js";
import { DEFAULT_NO_CALL_START_MS, type NewSessionSettings } from "./session/ensureSession.js";
import { createSessionServices, type SessionServices } from "./session/services.js";
import { chatSocketRoutes } from "./ws/chat.js";
import { type ActiveCalls, callSocketRoutes, type VoiceDeps } from "./ws/call.js";
import type { SocketDeps } from "./ws/handshake.js";
import { DEFAULT_KEEPALIVE, type KeepAliveOptions } from "./ws/keepAlive.js";
import { websocketSupport } from "./ws/plugin.js";

const HOUR_MS = 60 * 60 * 1000;

export interface AppOptions {
  logger: FastifyBaseLogger;
  db: Database;
  webDistDir: string;
  requireWebBuild: boolean;
  /** The page's origin; WebSocket connections from any other Origin are refused (D07). */
  publicOrigin: string;
  /** Trusted reverse-proxy hops for the client IP (0: the socket address). */
  trustProxyHops?: number;
  /** New sessions per client IP per hour (default 20). */
  newSessionsPerIpPerHour?: number;
  /** Enables the test-only API (POST /api/sessions, POST /api/sessions/:id/finalize, GET /hooks/records) when set. */
  testApiToken?: Secret | null;
  /** HOOK_SECRET: enables the stub record receiver (POST /hooks/records, P7-T04). */
  hookSecret?: Secret | null;
  keepAlive?: KeepAliveOptions;
  /** The hub and command processor; created here when not given (index.ts passes its own to share with the sweeper). */
  services?: SessionServices;
  /** Read-API requests per client IP per minute (default 60). */
  apiRateLimitPerMinute?: number;
  /** The call's providers and limits (P5). Without them /call refuses with 1011 (tests that don't call). */
  voice?: VoiceDeps | null;
  /** FILE_URL_SECRET: enables uploads and signed downloads (P4-T03). Without it, the file routes aren't registered. */
  fileUrlSecret?: Secret | null;
  fileUrlTtlSeconds?: number;
  /** UPLOAD_BUDGET_BYTES (default 600 MB). */
  uploadBudgetBytes?: number;
  /** PD10: a new session's noCallStart deadline (default 2 minutes). */
  noCallStartMs?: number;
  /** Uploads read at once on this instance (default 2); uploads and downloads per client IP per minute (30, 120). */
  maxConcurrentUploads?: number;
  uploadsPerMinute?: number;
  downloadsPerMinute?: number;
  uploadBytesPerIpPerHour?: number;
  uploadDeadlineMs?: number;
  /** The free-tier quota guard (P10-T03). Also set on `voice.quota`; the app uses it for `voiceAvailable` and the override route. */
  quota?: QuotaGuard | null;
}

/** The file-link signer for this configuration, or null when FILE_URL_SECRET isn't set (shared with index.ts). */
export function fileUrlSigner(options: Pick<AppOptions, "fileUrlSecret" | "fileUrlTtlSeconds" | "publicOrigin">): FileUrlSigner | null {
  if (!options.fileUrlSecret) return null;
  return createFileUrlSigner({ secret: options.fileUrlSecret, publicOrigin: options.publicOrigin, ttlSeconds: options.fileUrlTtlSeconds });
}

/** The app, and the calls it runs (tests wait on them; shutdown ends them through the 1012 close). */
export const activeCalls = new WeakMap<FastifyInstance, ActiveCalls>();

/**
 * Waits (at most `timeoutMs`) for every call to finish ending: EndCall must commit before the pool closes, or the
 * session would be left with an active call (P5 review #4). Shutdown's 1012 close has already started each end.
 */
export async function settleCalls(app: FastifyInstance, timeoutMs = 3_000): Promise<boolean> {
  const calls = activeCalls.get(app);
  if (!calls || calls.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([calls.settled().then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { logger, db, webDistDir, requireWebBuild, publicOrigin } = options;
  const trustProxyHops = options.trustProxyHops ?? 0;
  // Trust the nearest `trustProxyHops` proxies (what proxy-addr does with a hop count), so request.ip is the address
  // the outermost trusted proxy saw. Hop 0 is the socket peer.
  const trustProxy = trustProxyHops > 0 ? (_address: string, hop: number) => hop < trustProxyHops : false;
  const app = Fastify({ loggerInstance: logger, return503OnClosing: true, trustProxy });

  // Client errors keep Fastify's message (it describes the request, e.g. a bad body); server errors never
  // expose internals.
  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, request, reply) => {
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: error.code ?? "bad_request", message: error.message });
  });

  const signer = fileUrlSigner(options);
  const services = options.services ?? createSessionServices({ pool: db.pool, log: logger, signFileUrl: signer?.sign });
  // A new session's noCallStart timer (P4-T04) reaches the sweeper the same way a command's timers do.
  const newSession: NewSessionSettings = {
    noCallStartMs: options.noCallStartMs ?? DEFAULT_NO_CALL_START_MS,
    onTimerScheduled: (dueAt) => services.processor.timerScheduled(dueAt),
  };
  const sessionLimiter = new CreationLimiter({ max: options.newSessionsPerIpPerHour ?? 20, windowMs: HOUR_MS });
  const socketDeps: SocketDeps = {
    pool: db.pool,
    publicOrigin,
    sessionLimiter,
    keepAlive: options.keepAlive ?? DEFAULT_KEEPALIVE,
    newSession,
  };

  registerSecurityHeaders(app, publicOrigin);
  await app.register(healthRoutes, { pool: db.pool });
  await websocketSupport(app);
  await chatSocketRoutes(app, { ...socketDeps, hub: services.hub, processor: services.processor, voiceAvailable: options.quota ? () => options.quota?.voiceAvailable() ?? true : undefined });
  activeCalls.set(app, await callSocketRoutes(app, { ...socketDeps, hub: services.hub, processor: services.processor, voice: options.voice ?? null }));
  await sessionReadRoutes(app, { pool: db.pool, perMinute: options.apiRateLimitPerMinute });
  if (signer) {
    await fileRoutes(app, {
      pool: db.pool,
      signer,
      budgetBytes: options.uploadBudgetBytes ?? DEFAULT_UPLOAD_BUDGET_BYTES,
      sessionLimiter,
      newSession,
      maxConcurrentUploads: options.maxConcurrentUploads,
      uploadsPerMinute: options.uploadsPerMinute,
      downloadsPerMinute: options.downloadsPerMinute,
      uploadBytesPerIpPerHour: options.uploadBytesPerIpPerHour,
      uploadDeadlineMs: options.uploadDeadlineMs,
    });
  }
  if (options.quota?.canOverride) await quotaRoutes(app, { guard: options.quota });
  if (options.testApiToken) await testSessionRoutes(app, { pool: db.pool, testApiToken: options.testApiToken, newSession, processor: services.processor });
  if (options.hookSecret) await hookRoutes(app, { pool: db.pool, hookSecret: options.hookSecret, testApiToken: options.testApiToken });
  await webRoutes(app, { distDir: webDistDir, requireBuild: requireWebBuild });
  return app;
}
