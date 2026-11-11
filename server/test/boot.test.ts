// Starts the compiled server as a real process (built by build.global.ts) against the throwaway test database.
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validEnv } from "./fixtures.js";
import { createTestSchema, type TestSchema } from "./helpers/db.js";
import { ENTRY, expectNoFakeValues, processEnv, start } from "./helpers/process.js";

function migrationLog(output: string): { applied: string[]; count: number } {
  const line = output.split("\n").find((l) => l.includes('"msg":"migrations complete"'));
  if (!line) throw new Error(`no migrations log line:\n${output}`);
  return JSON.parse(line) as { applied: string[]; count: number };
}

let schema: TestSchema;
beforeAll(async () => {
  schema = await createTestSchema("boot");
});
afterAll(async () => {
  await schema.drop();
});

const serverEnv = (databaseUrl: string) =>
  validEnv({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "production", PUBLIC_ORIGIN: "https://repair.example.com", DATABASE_URL: databaseUrl });

describe("server boot: configuration", () => {
  it("exits non-zero naming a missing key, without printing any value", () => {
    const result = spawnSync(process.execPath, [ENTRY], {
      env: processEnv(validEnv({ GROQ_API_KEY: undefined, NODE_ENV: "test" })),
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("GROQ_API_KEY is missing");
    expectNoFakeValues(output);
  });

  it("names an invalid value without echoing it", () => {
    const result = spawnSync(process.execPath, [ENTRY], {
      env: processEnv(validEnv({ HOOK_SECRET: "short-hook-secret-value", NODE_ENV: "test" })),
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("HOOK_SECRET is invalid");
    expect(output).not.toContain("short-hook-secret-value");
    expectNoFakeValues(output);
  });
});

describe("server boot: database", () => {
  it("migrates an empty database on first boot, serves the UI and readiness, and shuts down cleanly", async () => {
    const server = await start(serverEnv(schema.url));
    try {
      expect(migrationLog(server.output())).toMatchObject({ applied: ["001_init"], count: 1 });

      const page = await fetch(`${server.address}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<div id="root"></div>');
      expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);

      const api = await fetch(`${server.address}/api/x`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: "not_found" });

      expect(await (await fetch(`${server.address}/healthz`)).json()).toEqual({ status: "ok" });
      const ready = await fetch(`${server.address}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok" });
    } finally {
      expect(await server.stop()).toBe(0);
    }
    expect(server.output()).toContain('"msg":"shutdown complete"');
    expectNoFakeValues(server.output());
  }, 40_000);

  it("applies 0 migrations on the second boot", async () => {
    const server = await start(serverEnv(schema.url));
    expect(migrationLog(server.output())).toMatchObject({ applied: [], count: 0 });
    expect(await server.stop()).toBe(0);
  }, 40_000);

  it("applies each migration once when two servers boot at the same time on an empty database", async () => {
    const fresh = await createTestSchema("boot2");
    try {
      const servers = await Promise.all([start(serverEnv(fresh.url)), start(serverEnv(fresh.url))]);
      const applied = servers.flatMap((s) => migrationLog(s.output()).applied);
      expect(applied).toEqual(["001_init"]);
      for (const s of servers) expect(await s.stop()).toBe(0);
    } finally {
      await fresh.drop();
    }
  }, 40_000);

  it("retries once, then exits non-zero without printing the URL's password, when the database is unreachable", () => {
    const result = spawnSync(process.execPath, [ENTRY], {
      env: processEnv(serverEnv("postgresql://someone:fake-db-password-000@127.0.0.1:1/none")),
      encoding: "utf8",
      timeout: 20_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("database not reachable; retrying once");
    expect(output).toContain("server failed to start");
    expect(output).toContain("ECONNREFUSED");
    expectNoFakeValues(output);
  }, 30_000);
});
