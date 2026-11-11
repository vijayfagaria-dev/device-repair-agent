// A real listening app (sockets can't go through `inject` with real Origin headers) and a small `ws` client.
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { type AppOptions, buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";

export const ORIGIN = "https://repair.example.com";

export interface RunningApp {
  app: FastifyInstance;
  http: string;
  ws: string;
  close(): Promise<void>;
}

export async function startApp(db: Database, options: Partial<AppOptions> = {}): Promise<RunningApp> {
  const app = await buildApp({
    logger: createLogger("silent"),
    db,
    webDistDir: "/nonexistent",
    requireWebBuild: false,
    publicOrigin: ORIGIN,
    ...options,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, http: address, ws: address.replace(/^http/, "ws"), close: () => app.close() };
}

export interface Closed {
  code: number;
  reason: string;
}

export interface TestSocket {
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<Closed>;
  /** Text messages received so far, parsed as JSON. */
  messages: unknown[];
  /** Resolves once at least `count` messages have arrived. */
  waitForMessages(count: number, timeoutMs?: number): Promise<unknown[]>;
}

export interface ConnectOptions {
  /** Origin header; null sends none. Defaults to the app's public origin. */
  origin?: string | null;
  headers?: Record<string, string>;
  autoPong?: boolean;
}

export function connect(url: string, { origin = ORIGIN, headers = {}, autoPong = true }: ConnectOptions = {}): TestSocket {
  const ws = new WebSocket(url, { headers: { ...(origin === null ? {} : { origin }), ...headers }, autoPong });
  const messages: unknown[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data, isBinary) => {
    messages.push(isBinary ? data : JSON.parse(String(data)));
    for (const wake of waiters.splice(0)) wake();
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  opened.catch(() => {});
  const closed = new Promise<Closed>((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  const waitForMessages = (count: number, timeoutMs = 3_000) =>
    new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`got ${messages.length} of ${count} messages`)), timeoutMs);
      const check = () => {
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages);
        } else waiters.push(check);
      };
      check();
    });
  return { ws, opened, closed, messages, waitForMessages };
}

/** Resolves with the close, or with "open" if the socket is still open after `ms`. */
export function closedWithin(socket: TestSocket, ms: number): Promise<Closed | "open"> {
  return Promise.race([socket.closed, new Promise<"open">((resolve) => setTimeout(() => resolve("open"), ms))]);
}
