// Graceful shutdown (P8-T02). Every deploy restarts the server, so a clean stop must not leave a call half-open or lose
// a write. Order, all inside one hard limit (default 10 s, Render's documented default grace is 30 s):
//  1. stop accepting and close the sockets: /call and /chat get 1012 "server restarting" (app.close, ws/plugin.ts)
//  2. let every call finish ending: its EndCall must commit before the pool closes (settleCalls)
//  3. stop the sweeper (the only background source of commands), then drain the commands still in flight
//  4. stop the outbox worker (an unfinished delivery keeps its lease and is redelivered after a restart)
//  5. end the database pool last
// A step that fails or times out is logged and the next one still runs; only the hard limit forces exit code 1.
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

export interface ShutdownDeps {
  log: FastifyBaseLogger;
  /** Stops accepting and closes the sockets (Fastify's close). */
  closeServer: () => Promise<void>;
  /** Resolves true when every call has finished ending. */
  settleCalls: () => Promise<boolean>;
  stopSweeper: () => Promise<void>;
  drainCommands: (timeoutMs: number) => Promise<boolean>;
  stopOutbox: () => Promise<void>;
  pool: Pick<pg.Pool, "end">;
  /** The hard limit for the whole shutdown (default 10 s). */
  timeoutMs?: number;
  /** How long the command drain may take (default 3 s). */
  drainMs?: number;
  exit?: (code: number) => void;
}

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { log } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let started = false;

  async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    const began = Date.now();
    try {
      const result = await run();
      log.info({ step: name, ms: Date.now() - began }, "shutdown step done");
      return result;
    } catch (err) {
      log.error({ step: name, err }, "shutdown step failed");
      return undefined;
    }
  }

  return async (signal) => {
    if (started) return; // a second signal while stopping changes nothing
    started = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error({ timeoutMs: deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS }, "shutdown timed out");
      exit(1);
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    force.unref();

    await step("close sockets", deps.closeServer);
    if ((await step("settle calls", deps.settleCalls)) === false) log.warn("calls still ending at shutdown");
    await step("stop sweeper", deps.stopSweeper);
    if ((await step("drain commands", () => deps.drainCommands(deps.drainMs ?? 3_000))) === false) log.warn("commands still running at shutdown");
    await step("stop outbox", deps.stopOutbox);
    await step("close database", () => deps.pool.end());

    clearTimeout(force);
    log.info("shutdown complete");
    exit(0);
  };
}

/** SIGTERM (a deploy) and SIGINT (Ctrl-C) start the shutdown once. */
export function installSignalHandlers(shutdown: (signal: string) => Promise<void>): void {
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
