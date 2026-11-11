// WebSocket support (D02: the `ws` library, through @fastify/websocket so upgrades go through Fastify's router,
// hooks, logging and trustProxy). Routes: /chat (ws/chat.ts) and /call (ws/call.ts).
import fastifyWebsocket from "@fastify/websocket";
import { CloseCode, CloseReason } from "@device-repair/shared/protocol";
import type { FastifyInstance } from "fastify";
import { closeWithNotice } from "./closing.js";

/** The largest inbound message on any socket (protocol.md §7: /chat 64 KB). /call enforces its smaller 4 KB itself. */
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

/** How long shutdown waits for clients to answer the 1012 close before dropping them. */
export const SHUTDOWN_CLOSE_GRACE_MS = 2_000;

export async function websocketSupport(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_WS_PAYLOAD_BYTES },
    // Socket-level errors (an oversized message, or an unclean client disconnect) are expected noise: log the code
    // only. ws is already closing the socket after a protocol error (e.g. it has sent 1009), so terminating then
    // could discard that close frame; anything else is dropped.
    errorHandler(error, socket, request) {
      request.log.warn({ code: (error as { code?: string }).code, message: error.message }, "websocket error");
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.terminate();
    },
    // Shutdown: tell every client the server is restarting, so /chat reconnects and replays (protocol.md §6).
    // ws waits for each client to answer the close (up to 30 s); clients that haven't within the grace period are
    // dropped, so shutdown stays well inside the process's 10 s limit.
    preClose(done) {
      const server = app.websocketServer;
      for (const client of server.clients) closeWithNotice(client, CloseCode.SERVER_RESTARTING, CloseReason.SERVER_RESTARTING);
      const force = setTimeout(() => {
        for (const client of server.clients) client.terminate();
      }, SHUTDOWN_CLOSE_GRACE_MS);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        done();
      });
    },
  });
}
