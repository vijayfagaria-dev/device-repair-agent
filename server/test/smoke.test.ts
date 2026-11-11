// The P1-T06 smoke script, run as on the deployed URL but against the compiled server as a real local process:
// it must pass, prove persistence across a restart, and fail when something is wrong.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validEnv } from "./fixtures.js";
import { createTestSchema, type TestSchema } from "./helpers/db.js";
import { start } from "./helpers/process.js";

const SMOKE = fileURLToPath(new URL("./smoke/deployed-smoke.ts", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function runSmoke(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SMOKE, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let schema: TestSchema;
let port: number;
let base: string;
const env = () => validEnv({ HOST: "127.0.0.1", PORT: String(port), PUBLIC_ORIGIN: base, DATABASE_URL: schema.url, NODE_ENV: "development" });

beforeAll(async () => {
  schema = await createTestSchema("smoke");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await schema.drop();
});

describe("deployed-smoke.ts against a local server", () => {
  it("passes every check, and after a restart proves the session row persisted before reconnecting", async () => {
    const first = await start(env());
    let sessionId: string;
    try {
      // No /call check here: the local server has fake provider keys (the deployed run places a real call).
      const run = runSmoke([base, "--skip-call"], { DATABASE_URL: schema.url });
      expect(run.output).toContain("ALL 8 CHECKS PASSED");
      expect(run.status).toBe(0);
      expect(run.output).not.toContain(schema.url);
      sessionId = /Session: ([0-9a-f-]{36})/.exec(run.output)?.[1] ?? "";
      expect(sessionId).not.toBe("");
    } finally {
      expect(await first.stop()).toBe(0);
    }

    const second = await start(env());
    try {
      const run = runSmoke([base, "--session", sessionId, "--skip-call"], { DATABASE_URL: schema.url });
      expect(run.output).toContain("PASS  session row persisted (checked before connecting)");
      expect(run.output).toContain("ALL 9 CHECKS PASSED");
      expect(run.status).toBe(0);
    } finally {
      expect(await second.stop()).toBe(0);
    }
  }, 120_000);

  it("fails when the session row is missing, or the server refuses the page's origin", async () => {
    const server = await start({ ...env(), PUBLIC_ORIGIN: "https://somewhere-else.example.com" });
    try {
      const run = runSmoke([base, "--session", randomUUID()], { DATABASE_URL: schema.url });
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL  session row persisted (checked before connecting): no sessions row for this id");
      expect(run.output).toMatch(/FAIL {2}WSS \/chat opens and stays open .*: server closed it: 4403 origin not allowed/);
      // The call check runs here: the refusal comes before any provider is contacted.
      expect(run.output).toMatch(/FAIL {2}WSS \/call answers.*4403/);
    } finally {
      expect(await server.stop()).toBe(0);
    }
  }, 120_000);

  it("refuses bad arguments without contacting anything", () => {
    expect(runSmoke([]).status).toBe(2);
    expect(runSmoke(["ftp://example.com"]).status).toBe(2);
    expect(runSmoke([base, "--session", "abc"]).status).toBe(2);
    const noDb = runSmoke([base, "--session", randomUUID()]);
    expect(noDb.status).toBe(2);
    expect(noDb.output).toContain("--session needs DATABASE_URL");
  });
});
