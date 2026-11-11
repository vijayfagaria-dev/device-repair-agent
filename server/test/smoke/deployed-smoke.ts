// Walking-skeleton smoke test for a deployed (or local) server (P1-T06). Runs on plain Node 22 (type stripping); no
// build, no extra tools.
//
//   node test/smoke/deployed-smoke.ts https://<app>.onrender.com            # first run: prints the session id
//   DATABASE_URL=... node test/smoke/deployed-smoke.ts <url> --session <id>  # after a restart: proves it persisted
//   ... --skip-call   # no /call check (a local server with fake provider keys can't answer a call)
//
// The /call check (P5-T02, replacing the P1 echo) places a real call: it streams silent mic frames and waits for the
// agent's greeting (audio and its transcript line), then hangs up. It uses a few seconds of real provider quota.
//
// With DATABASE_URL set, the sessions row is also checked directly (read-only). With --session, that check runs
// before anything connects to the session, so lazy creation can't hide a lost row. The URL is never printed.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { WebSocket } from "ws";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIC_FRAME_BYTES = 640;
const CALL_TIMEOUT_MS = 20_000;
// A free Render instance that has gone to sleep takes about a minute to wake on the first request.
const FIRST_REQUEST_TIMEOUT_MS = 120_000;
const TIMEOUT_MS = 15_000;

interface Args {
  base: URL;
  sessionId: string | null;
  skipCall: boolean;
}

function parseArgs(argv: string[]): Args {
  const [url, ...rest] = argv;
  if (!url) throw new Error("usage: deployed-smoke.ts <base-url> [--session <uuid>] [--skip-call]");
  const base = new URL(url);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("base URL must be http(s)");
  let sessionId: string | null = null;
  let skipCall = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--session") {
      sessionId = rest[i + 1] ?? "";
      i += 1;
      if (!UUID_V4.test(sessionId)) throw new Error("--session needs a UUIDv4");
      sessionId = sessionId.toLowerCase();
    } else if (rest[i] === "--skip-call") {
      skipCall = true;
    } else {
      throw new Error(`unknown arguments: ${rest.slice(i).join(" ")}`);
    }
  }
  return { base, sessionId, skipCall };
}

const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ""}`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}: ${detail}`);
    return false;
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function get(base: URL, path: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  return fetch(new URL(path, base), { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
}

interface SocketResult {
  opened: boolean;
  close: { code: number; reason: string } | null;
  messages: unknown[];
}

/** Opens a socket, runs `whileOpen`, and reports what happened. Never throws on a close. */
function socketSession(
  url: string,
  origin: string,
  whileOpen: (ws: WebSocket, messages: unknown[]) => Promise<void>,
): Promise<SocketResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin }, handshakeTimeout: TIMEOUT_MS });
    const result: SocketResult = { opened: false, close: null, messages: [] };
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("socket timed out"));
    }, TIMEOUT_MS * 2);
    ws.on("message", (data) => result.messages.push(JSON.parse(String(data))));
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      result.close ??= { code, reason: String(reason) };
      resolve(result);
    });
    ws.on("open", () => {
      result.opened = true;
      whileOpen(ws, result.messages).then(
        () => ws.close(1000),
        (err: unknown) => {
          ws.terminate();
          reject(err);
        },
      );
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await sleep(20);
  }
}

async function sessionRowExists(databaseUrl: string, sessionId: string): Promise<boolean> {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: sslmode === "disable" || (local && !sslmode) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: TIMEOUT_MS,
  });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId]);
    return rows.length === 1;
  } finally {
    await client.end();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { base, sessionId: given } = args;
  const databaseUrl = process.env.DATABASE_URL?.trim() || null;
  if (given && !databaseUrl) throw new Error("--session needs DATABASE_URL to check the row before connecting");
  const origin = base.origin;
  const ws = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}`;
  const sessionId = given ?? randomUUID();
  console.log(`Smoke test of ${origin} (session ${sessionId})`);

  await check("GET /healthz → 200", async () => {
    const res = await get(base, "/healthz", FIRST_REQUEST_TIMEOUT_MS);
    assert(res.status === 200, `status ${res.status}`);
    return "";
  });
  await check("GET / → 200 HTML (the UI)", async () => {
    const res = await get(base, "/");
    assert(res.status === 200, `status ${res.status}`);
    assert((res.headers.get("content-type") ?? "").startsWith("text/html"), `content-type ${res.headers.get("content-type")}`);
    assert((await res.text()).includes('id="root"'), "not the UI page");
    return "";
  });
  await check("GET /readyz → 200 (database reachable)", async () => {
    const res = await get(base, "/readyz");
    assert(res.status === 200, `status ${res.status}`);
    return "";
  });
  await check("GET /api/x → 404 JSON, not the UI", async () => {
    const res = await get(base, "/api/x");
    assert(res.status === 404, `status ${res.status}`);
    assert((res.headers.get("content-type") ?? "").startsWith("application/json"), `content-type ${res.headers.get("content-type")}`);
    return "";
  });

  if (given && databaseUrl) {
    await check("session row persisted (checked before connecting)", async () => {
      assert(await sessionRowExists(databaseUrl, sessionId), "no sessions row for this id");
      return "";
    });
  }

  await check("WSS /chat?sessionId=abc → close 4400", async () => {
    const { opened, close } = await socketSession(`${ws}/chat?sessionId=abc`, origin, () => sleep(TIMEOUT_MS));
    assert(opened, "upgrade did not complete");
    assert(close?.code === 4400, `closed with ${close?.code} ${close?.reason}`);
    return close.reason;
  });
  await check("WSS /chat from a foreign Origin → close 4403", async () => {
    const { close } = await socketSession(`${ws}/chat?sessionId=${randomUUID()}`, "https://smoke-test.invalid", () => sleep(TIMEOUT_MS));
    assert(close?.code === 4403, `closed with ${close?.code} ${close?.reason}`);
    return close.reason;
  });
  await check("WSS /chat opens and stays open (session loaded or created)", async () => {
    const { opened, close } = await socketSession(`${ws}/chat?sessionId=${sessionId}`, origin, () => sleep(1_500));
    assert(opened, "did not open");
    assert(close?.code === 1000, `server closed it: ${close?.code} ${close?.reason}`);
    return "";
  });
  if (databaseUrl) {
    await check("sessions row exists after the /chat connect", async () => {
      assert(await sessionRowExists(databaseUrl, sessionId), "no sessions row for this id");
      return "";
    });
  }
  if (!args.skipCall) {
    await check("WSS /call answers: the agent's greeting arrives (audio and its transcript line)", async () => {
      const started = Date.now();
      let firstAudioMs = 0;
      const { close } = await socketSession(`${ws}/call?sessionId=${sessionId}`, origin, async (socket, received) => {
        const silence = Buffer.alloc(MIC_FRAME_BYTES); // a quiet mic: the agent greets anyway
        const timer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(silence);
        }, 20);
        try {
          await waitFor(() => received.some((m) => (m as { type?: unknown }).type === "audio"), CALL_TIMEOUT_MS);
          firstAudioMs = Date.now() - started;
          await waitFor(() => received.some((m) => (m as { type?: unknown; role?: unknown }).type === "transcript" && (m as { role?: unknown }).role === "agent"), CALL_TIMEOUT_MS);
        } finally {
          clearInterval(timer);
        }
      });
      assert(close?.code === 1000, `server closed it: ${close?.code} ${close?.reason}`);
      return `first agent audio ${firstAudioMs} ms after connecting`;
    });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED. Session: ${sessionId}` : `\n${failed} of ${results.length} checks FAILED`);
  if (failed === 0 && !given) {
    console.log("To verify persistence: restart the service, then run again with DATABASE_URL set and --session <id>.");
  }
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
