// A spawnable server for the chaos tests (P8-T03): the compiled server as a real process against the throwaway test
// database, with an armed failpoint (util/failpoints.ts: it SIGKILLs itself there). The receiver is the server's own stub,
// which stores into received_records, so "exactly one stored record, duplicates only count" is asked of the database.
import { type ChildProcess, spawn } from "node:child_process";
import { FAKE, validEnv } from "../fixtures.js";
import { ENTRY, processEnv } from "../helpers/process.js";

export const CHAOS_ORIGIN = "http://localhost:8080";

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Spawned {
  child: ChildProcess;
  /** Resolves with the base URL once the server listens; rejects if it exits first. */
  listening: Promise<string>;
  exit: Promise<Exit>;
  output(): string;
  /** Output lines that are JSON log records, parsed. */
  logs(): Record<string, unknown>[];
  /** SIGTERM and wait for the exit. */
  stop(): Promise<Exit>;
}

export function spawnServer(databaseUrl: string, options: { failpoints?: string; env?: Record<string, string | undefined> } = {}): Spawned {
  const env = validEnv({
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    PUBLIC_ORIGIN: CHAOS_ORIGIN,
    DATABASE_URL: databaseUrl,
    ALLOW_TEST_API: "true",
    TEST_API_TOKEN: FAKE.TEST_API_TOKEN,
    ...(options.failpoints ? { FAILPOINTS: options.failpoints } : {}),
    ...options.env,
  });
  const child = spawn(process.execPath, [ENTRY], { env: processEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exit = new Promise<Exit>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const listening = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 25_000);
    void exit.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${signal ?? code}) before listening`));
    });
    const onData = (chunk: unknown) => {
      output += String(chunk);
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
  });
  listening.catch(() => {}); // a server that dies on purpose before listening is not an unhandled rejection
  return {
    child,
    listening,
    exit,
    output: () => output,
    logs: () =>
      output
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    stop: () => {
      child.kill("SIGTERM");
      return exit;
    },
  };
}

/** Waits for the process to exit, failing (and killing it) if it doesn't within `ms`: a failpoint that never fires. */
export async function exitsWithin(server: Spawned, ms = 20_000): Promise<Exit> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      reject(new Error(`the server did not die at its failpoint within ${ms} ms:\n${server.output()}`));
    }, ms);
  });
  try {
    return await Promise.race([server.exit, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const finalizeRequest = (address: string, sessionId: string) =>
  fetch(`${address}/api/sessions/${sessionId}/finalize`, { method: "POST", headers: { authorization: `Bearer ${FAKE.TEST_API_TOKEN}` } });
