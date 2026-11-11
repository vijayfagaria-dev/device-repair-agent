// Session identity and WebSocket close codes (protocol.md §2 and §6).

/** A UUIDv4, either case (protocol.md §2). The browser generates it; the server rejects anything else. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns the canonical (lowercase) session id, or null when `raw` is not a UUIDv4. */
export function parseSessionId(raw: unknown): string | null {
  return typeof raw === "string" && SESSION_ID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Close codes the server sends on /chat and /call. The server always completes the WebSocket upgrade and then closes
 * with one of these, because browsers report a refused upgrade only as a bare 1006.
 */
export enum CloseCode {
  NORMAL = 1000,
  MESSAGE_TOO_BIG = 1009,
  SERVER_ERROR = 1011,
  SERVER_RESTARTING = 1012,
  INVALID_SESSION_ID = 4400,
  ORIGIN_NOT_ALLOWED = 4403,
  CALL_ALREADY_ACTIVE = 4409,
  SESSION_CLOSED = 4410,
  /** /call: the user opted out earlier; the chat asks "Resume your claim?" first (protocol v1.5, P7-T05). */
  RESUME_REQUIRED = 4411,
  /** /call: concurrent-call cap or quota guard. /chat: too many new sessions from one address (protocol v1.1). */
  RATE_LIMITED = 4429,
}

export const CloseReason = {
  SERVER_ERROR: "server error",
  SERVER_RESTARTING: "server restarting",
  INVALID_SESSION_ID: "invalid session id",
  ORIGIN_NOT_ALLOWED: "origin not allowed",
  NEW_SESSION_RATE_LIMITED: "rate limited",
} as const;
