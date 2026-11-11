import type { WebSocket } from "ws";

/**
 * Closes a /call or /chat socket after telling the client why in a `closing` message (protocol.md v1.7). The close
 * code carries the same information, but Render's proxy replaces custom 4xxx codes with 1000/1005/1006, so the page
 * can't rely on it alone. Safe to call on a socket that is already closing.
 */
export function closeWithNotice(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "closing", code, reason }));
    } catch {
      // The close below still carries the code where the network keeps it.
    }
  }
  socket.close(code, reason);
}
