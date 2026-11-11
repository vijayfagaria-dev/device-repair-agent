// Serves the built web UI (web/dist) from the same origin as the API (D07), with a SPA fallback that never
// answers API paths or missing assets with HTML.
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Path prefixes owned by the server. Unknown paths under them get a JSON 404, never the UI. */
export const SERVER_PREFIXES = ["/api", "/sessions", "/files", "/hooks", "/call", "/chat", "/healthz", "/readyz"];

export function isServerPath(pathname: string): boolean {
  return SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** A last path segment with a dot looks like a file (`/assets/app.js`); a missing file must 404, not get HTML. */
function looksLikeFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

export interface WebOptions {
  distDir: string;
  /** Fail instead of starting without a UI (production). */
  requireBuild: boolean;
}

export async function webRoutes(app: FastifyInstance, { distDir, requireBuild }: WebOptions): Promise<void> {
  const hasBuild = existsSync(join(distDir, "index.html"));
  if (!hasBuild) {
    if (requireBuild) throw new Error(`Web build not found at ${distDir}; run npm run build first`);
    app.log.warn({ distDir }, "web build not found; serving the API only");
  } else {
    await app.register(fastifyStatic, {
      root: distDir,
      dotfiles: "ignore",
      cacheControl: false,
      setHeaders(reply, filePath) {
        // Vite fingerprints everything under assets/, so it can be cached forever; the HTML must always revalidate.
        const immutable = filePath.startsWith(join(distDir, "assets"));
        reply.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "/";
    const isPageRequest = request.method === "GET" || request.method === "HEAD";
    if (hasBuild && isPageRequest && !isServerPath(pathname) && !looksLikeFile(pathname)) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
