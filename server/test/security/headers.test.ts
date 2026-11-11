// Security headers (P10-T02): present on every kind of response, a CSP with no third parties and no inline allowances,
// the page's own socket origin in connect-src, HSTS only over https, the microphone allowed for the page itself only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { contentSecurityPolicy, securityHeaders } from "../../src/http/security.js";
import { type RunningApp, startApp } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let db: Database;
let server: RunningApp;
let dist: string;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("headers"));
  dist = mkdtempSync(join(tmpdir(), "headers-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>x</title>");
  server = await startApp(db, { webDistDir: dist, requireWebBuild: true, hookSecret: new Secret("h".repeat(32)) });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

const EXPECTED = ["content-security-policy", "referrer-policy", "permissions-policy", "x-content-type-options", "cross-origin-opener-policy", "strict-transport-security"];

describe("security headers", () => {
  it.each([
    ["the page", "/", 200],
    ["a SPA route", "/some/page", 200],
    ["a health check", "/healthz", 200],
    ["an API 404", "/api/nothing", 404],
    ["a missing asset", "/assets/missing.js", 404],
    ["a method the route doesn't allow", "/hooks/records", 404],
  ])("%s carries every header", async (_name, url, status) => {
    const response = await fetch(`${server.http}${url}`);
    expect(response.status).toBe(status);
    for (const name of EXPECTED) expect(response.headers.get(name), name).toBeTruthy();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("microphone=(self)");
  });

  it("also covers error responses produced by the app's error handler (a malformed request)", async () => {
    const response = await fetch(`${server.http}/hooks/records`, { method: "POST", headers: { "x-hook-secret": "h".repeat(32), "content-type": "application/json" }, body: "{" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toBeTruthy();
  });

  it("has a CSP that loads nothing from other origins and allows no inline script or style", () => {
    const csp = contentSecurityPolicy("https://repair.example.com");
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'", "wss://repair.example.com"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    expect(csp).not.toMatch(/unsafe-|\*|https?:\/\/(?!repair\.example\.com)/);
  });

  it("uses ws:// for an http origin, and sends HSTS only for https", () => {
    expect(contentSecurityPolicy("http://localhost:8080")).toContain("connect-src 'self' ws://localhost:8080");
    expect(securityHeaders("http://localhost:8080")["strict-transport-security"]).toBeUndefined();
    expect(securityHeaders("https://repair.example.com")["strict-transport-security"]).toBe("max-age=31536000");
  });
});
