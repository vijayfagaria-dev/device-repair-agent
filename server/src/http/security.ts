// Security headers (P10-T02, MH6). Set on every HTTP response, including errors and the static UI. A WebSocket upgrade
// is not an HTTP response with these headers; its protection is the Origin check (ws/handshake.ts).
//
// The CSP is tight because the page needs little: its own script (Vite's bundle and the capture worklet are both files
// under /assets, so `script-src 'self'` covers `audioWorklet.addModule`), its own stylesheet (React sets styles through
// the CSSOM, which CSP allows, so there is no 'unsafe-inline'), the chat/call sockets on its own origin, and blob:
// images for the preview of a file the user is about to upload. Nothing is loaded from a third party.
import type { FastifyInstance } from "fastify";

/** The `connect-src` entry for the page's own WebSocket origin; `'self'` alone doesn't cover ws: in every browser. */
function socketOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

export function contentSecurityPolicy(publicOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob:",
    `connect-src 'self' ${socketOrigin(publicOrigin)}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(publicOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": contentSecurityPolicy(publicOrigin),
    "referrer-policy": "no-referrer",
    // The page may use its own microphone and nothing else; no embedded frame can.
    "permissions-policy": "microphone=(self), camera=(), geolocation=(), payment=(), usb=()",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
  };
  // Only over HTTPS: a browser ignores HSTS on plain HTTP, and local development runs on http://localhost.
  if (publicOrigin.startsWith("https://")) headers["strict-transport-security"] = "max-age=31536000";
  return headers;
}

/** Adds the headers to every response. Registered before the routes, so every scope inherits the hook. */
export function registerSecurityHeaders(app: FastifyInstance, publicOrigin: string): void {
  const headers = Object.entries(securityHeaders(publicOrigin));
  app.addHook("onRequest", async (_request, reply) => {
    for (const [name, value] of headers) reply.header(name, value);
  });
}
