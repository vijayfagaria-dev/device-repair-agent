import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase } from "../src/db/pool.js";
import { createLogger } from "../src/log.js";
import { SERVER_PREFIXES } from "../src/http/web.js";

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
let root: string;
let dist: string;
let app: FastifyInstance;
// Never queried by these tests; static hosting doesn't touch the database.
const db = createDatabase({ connectionString: "postgresql://nobody@127.0.0.1:1/none", onError: () => {} });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "web-dist-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX_HTML);
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1);");
  writeFileSync(join(dist, ".env"), "SHOULD_NOT_BE_SERVED=1");
  writeFileSync(join(root, "outside.txt"), "outside the web root");
  app = await buildApp({ logger: createLogger("silent"), db, webDistDir: dist, requireWebBuild: true, publicOrigin: "http://localhost:8080" });
  app.get("/api/boom", async () => {
    throw new Error("database password is hunter2");
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("static UI and SPA fallback", () => {
  it("GET / serves the UI with no-cache", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe(INDEX_HTML);
  });

  it("serves the UI for client-side paths, keeping the query string working", async () => {
    for (const url of ["/?sessionId=1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", "/claims/123", "/?demo=1", "/apiary", "/chatroom"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX_HTML);
    }
  });

  it("serves fingerprinted assets with a long immutable cache", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("GET /api/x returns a 404 JSON, not HTML", async () => {
    const res = await app.inject({ method: "GET", url: "/api/x" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("never answers server-owned paths with the UI", async () => {
    for (const prefix of SERVER_PREFIXES) {
      for (const url of [prefix, `${prefix}/`, `${prefix}/anything`, `${prefix}/a/b?x=1`]) {
        if (url === "/healthz" || url === "/readyz") continue; // real routes
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers["content-type"], url).toMatch(/^application\/json/);
      }
    }
  });

  it("returns 404 JSON for a missing file instead of HTML", async () => {
    for (const url of ["/assets/missing.js", "/favicon-missing.svg"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: "not_found" });
    }
  });

  it("returns 404 JSON for non-GET requests to unknown paths", async () => {
    const res = await app.inject({ method: "POST", url: "/claims/123", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("does not serve dotfiles or files outside the web root", async () => {
    for (const url of ["/.env", "/../outside.txt", "/..%2foutside.txt", "/assets/..%2f..%2foutside.txt", "/%2e%2e/outside.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, url).not.toContain("SHOULD_NOT_BE_SERVED");
      expect(res.body, url).not.toContain("outside the web root");
    }
  });

  it("hides internal error details on 5xx", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("hunter2");
  });
});

describe("/healthz", () => {
  it("returns ok without caching", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("missing web build", () => {
  it("fails to build when the UI is required (production)", async () => {
    await expect(
      buildApp({ logger: createLogger("silent"), db, webDistDir: join(root, "nope"), requireWebBuild: true, publicOrigin: "http://localhost:8080" }),
    ).rejects.toThrow(/Web build not found/);
  });

  it("serves the API only when the UI is optional (development)", async () => {
    const apiOnly = await buildApp({ logger: createLogger("silent"), db, webDistDir: join(root, "nope"), requireWebBuild: false, publicOrigin: "http://localhost:8080" });
    const page = await apiOnly.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(404);
    expect(page.json()).toEqual({ error: "not_found" });
    expect((await apiOnly.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await apiOnly.close();
  });
});
