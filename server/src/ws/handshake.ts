// The shared opening sequence for /chat and /call (protocol.md §4 step 1, §6): check Origin, check the session id,
// then load or lazily create the session. Every refusal completes the upgrade and then closes with a code and
// reason, because browsers hide refused upgrades behind a bare 1006.
import { CloseCode, CloseReason, parseSessionId } from "@device-repair/shared/protocol";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type pg from "pg";
import type { RawData, WebSocket } from "ws";
import type { Session } from "../db/repos/sessions.js";
import type { CreationLimiter } from "../session/creationLimit.js";
import { ensureSession, type NewSessionSettings, type SessionOrigin } from "../session/ensureSession.js";
import { type KeepAliveOptions, keepAlive } from "./keepAlive.js";

export interface SocketDeps {
  pool: pg.Pool;
  /** The only Origin a browser may connect from (D07). */
  publicOrigin: string;
  sessionLimiter: CreationLimiter;
  keepAlive: KeepAliveOptions;
  /** What a session created by this connect starts with (its noCallStart timer, P4-T04). */
  newSession?: NewSessionSettings;
}

/** Messages that arrive while the handshake is still talking to the database are held, up to this many. */
const MAX_PENDING_MESSAGES = 64;

export type MessageHandler = (data: RawData, isBinary: boolean) => void;

export interface SessionSocket {
  session: Session;
  log: FastifyBaseLogger;
  /** Starts delivering messages: first the ones held during the handshake, in order, then live ones. */
  onMessage(handler: MessageHandler): void;
}

export function isAllowedOrigin(origin: string | undefined, publicOrigin: string): boolean {
  return origin === publicOrigin;
}

// Render's proxy dropped the close code (the client saw 1005) when we closed right after the upgrade, so refusals
// wait a moment before closing. Harmless locally.
const REFUSE_DELAY_MS = 150;
function refuse(socket: WebSocket, code: number, reason: string): void {
  setTimeout(() => {
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  }, REFUSE_DELAY_MS);
}

/**
 * Runs the handshake on a freshly upgraded socket. Returns the session, or null after closing the socket with the
 * reason (or when the client went away during the handshake).
 */
export async function acceptSessionSocket(
  socket: WebSocket,
  request: FastifyRequest,
  deps: SocketDeps,
  via: SessionOrigin,
): Promise<SessionSocket | null> {
  let handler: MessageHandler | null = null;
  const pending: [RawData, boolean][] = [];
  let dropped = 0;
  socket.on("message", (data, isBinary) => {
    if (handler) handler(data, isBinary);
    else if (pending.length < MAX_PENDING_MESSAGES) pending.push([data, isBinary]);
    else dropped += 1;
  });
  keepAlive(socket, deps.keepAlive);

  if (!isAllowedOrigin(request.headers.origin, deps.publicOrigin)) {
    request.log.warn({ path: request.routeOptions.url }, "websocket refused: origin not allowed");
    refuse(socket, CloseCode.ORIGIN_NOT_ALLOWED, CloseReason.ORIGIN_NOT_ALLOWED);
    return null;
  }

  const sessionId = parseSessionId((request.query as Record<string, unknown> | undefined)?.sessionId);
  if (!sessionId) {
    request.log.info({ path: request.routeOptions.url }, "websocket refused: invalid session id");
    refuse(socket, CloseCode.INVALID_SESSION_ID, CloseReason.INVALID_SESSION_ID);
    return null;
  }

  const log = request.log.child({ sessionId });
  let result: Awaited<ReturnType<typeof ensureSession>>;
  try {
    result = await ensureSession(deps.pool, sessionId, { via, limit: { limiter: deps.sessionLimiter, key: request.ip }, newSession: deps.newSession });
  } catch (err) {
    log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "websocket refused: session lookup failed");
    refuse(socket, CloseCode.SERVER_ERROR, CloseReason.SERVER_ERROR);
    return null;
  }
  if (!result.ok) {
    log.warn("websocket refused: new-session rate limit");
    refuse(socket, CloseCode.RATE_LIMITED, CloseReason.NEW_SESSION_RATE_LIMITED);
    return null;
  }
  if (result.created) log.info({ via }, "session created");
  if (socket.readyState !== socket.OPEN) return null;

  return {
    session: result.session,
    log,
    onMessage(next) {
      handler = next;
      if (dropped > 0) log.warn({ dropped }, "messages dropped during the handshake");
      for (const [data, isBinary] of pending.splice(0)) next(data, isBinary);
    },
  };
}
