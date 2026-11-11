// The throwaway Postgres for the run (D21): TEST_DATABASE_URL if set (CI), else a temporary local cluster, the same one the
// unit tests use. Then the E2E backend (support/backend-process.mjs) as a child process; its URLs reach the specs through
// the environment, and both are stopped at the end.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import setup from "../server/test/db.global.js";

const BACKEND = fileURLToPath(new URL("./support/backend-process.mjs", import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  let databaseUrl = "";
  const stopDatabase = await setup({
    provide: (_key: string, value: string) => {
      databaseUrl = value;
    },
  } as never);
  const child = spawn(process.execPath, [BACKEND], { env: { PATH: process.env.PATH, E2E_DATABASE_URL: databaseUrl }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (c) => (output += String(c)));
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const ready = await new Promise<{ origin: string; control: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`E2E backend did not start:\n${output}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /READY (\{.*\})/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(JSON.parse(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`E2E backend exited (${code}):\n${output}`));
    });
  });
  process.env.E2E_URL = ready.origin;
  process.env.E2E_CONTROL = ready.control;
  return async () => {
    child.kill("SIGTERM");
    await exited;
    await stopDatabase();
  };
}
