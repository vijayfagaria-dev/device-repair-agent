// Provides a throwaway Postgres for the test run (D21). Tests never touch Neon.
// - TEST_DATABASE_URL set (CI: a GitHub Actions postgres service container): use it.
// - Otherwise: initdb a temporary cluster from local Postgres binaries, start it on a free port with durability
//   off, and delete it after the run. Binaries come from PG_BIN, Homebrew postgresql@18, or pg_config on PATH.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

function findPostgresBin(): string {
  const candidates = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin"];
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim());
  } catch {
    // pg_config not on PATH
  }
  const bin = candidates.find((dir) => dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")));
  if (!bin) {
    throw new Error(
      "No test database. Set TEST_DATABASE_URL to a disposable Postgres, or install Postgres 18 " +
        "(brew install postgresql@18) or set PG_BIN to its bin directory.",
    );
  }
  return bin;
}

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

async function waitUntilReady(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test Postgres exited early:\n${log()}`);
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`test Postgres did not start in time:\n${log()}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    project.provide("testDatabaseUrl", external);
    return async () => {};
  }

  const bin = findPostgresBin();
  const dataDir = mkdtempSync(join(tmpdir(), "dra-test-pg-"));
  execFileSync(join(bin, "initdb"), ["-D", dataDir, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--no-locale"], {
    stdio: "ignore",
  });
  const port = await freePort();
  let output = "";
  const child = spawn(
    join(bin, "postgres"),
    ["-D", dataDir, "-p", String(port), "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=",
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=200"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  try {
    await waitUntilReady(url, child, () => output);
  } catch (err) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  project.provide("testDatabaseUrl", url);

  return async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGINT"); // fast shutdown
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  };
}
