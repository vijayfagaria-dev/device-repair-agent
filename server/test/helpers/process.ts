// Runs the compiled server (built by build.global.ts) as a real process.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { FAKE } from "../fixtures.js";

export const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

// Only PATH is inherited, so a developer's real keys in the shell can't leak into the test.
export function processEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...env };
}

export function expectNoFakeValues(output: string): void {
  for (const value of Object.values(FAKE)) expect(output).not.toContain(value);
  expect(output).not.toContain("fake-db-password");
}

export interface Started {
  address: string;
  output: () => string;
  stop: () => Promise<number | null>;
}

/** Spawns the server and resolves once it listens. */
export function start(env: Record<string, string | undefined>): Promise<Started> {
  const child = spawn(process.execPath, [ENTRY], { env: processEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before listening:\n${output}`));
    });
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({
          address: match[1],
          output: () => output,
          stop: async () => {
            child.kill("SIGTERM");
            return exited;
          },
        });
      }
    });
  });
}

