import { sessionId, type Server } from "../config";

export const socketUrl = (server: Server, path: string): string =>
  `${server.ws}${path}?sessionId=${encodeURIComponent(sessionId)}`;

const hasType = (value: unknown): value is { type: string } =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

export function parseMessage<T extends { type: string }>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    const msg: unknown = JSON.parse(data);
    return hasType(msg) ? (msg as T) : null;
  } catch {
    return null;
  }
}

export function closeQuietly(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.close();
}

/**
 * The `closing` message the server sends just before it closes a socket (protocol.md v1.7), or null for any other
 * message. Render's proxy turns custom 4xxx close codes into 1000/1005/1006, so the page prefers this code.
 */
export function parseClosing(data: unknown): { code: number; reason: string } | null {
  const msg = parseMessage<{ type: string; code?: unknown; reason?: unknown }>(data);
  if (msg?.type !== "closing" || typeof msg.code !== "number") return null;
  return { code: msg.code, reason: typeof msg.reason === "string" ? msg.reason : "" };
}
