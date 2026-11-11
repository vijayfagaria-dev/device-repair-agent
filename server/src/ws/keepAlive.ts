// Server-side keepalive (protocol.md §7): ping every interval and terminate a socket that misses too many pongs.
// It also keeps Render's proxy from dropping idle sockets (P1-T06 risk).
import type { WebSocket } from "ws";

export interface KeepAliveOptions {
  intervalMs: number;
  /** Consecutive unanswered pings before the socket is terminated. */
  maxMissed: number;
}

export const DEFAULT_KEEPALIVE: KeepAliveOptions = { intervalMs: 20_000, maxMissed: 2 };

export function keepAlive(socket: WebSocket, { intervalMs, maxMissed }: KeepAliveOptions): void {
  let missed = 0;
  socket.on("pong", () => {
    missed = 0;
  });
  const timer = setInterval(() => {
    if (missed >= maxMissed) {
      socket.terminate();
      return;
    }
    missed += 1;
    socket.ping();
  }, intervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}
