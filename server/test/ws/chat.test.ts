// WS /chat handshake (P1-T03; protocol.md §2, §4 step 1, §6, §7): Origin, session id, lazy creation, rate limit,
// keepalive and shutdown, over a real socket.
import { randomBytes, randomUUID } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { SHUTDOWN_CLOSE_GRACE_MS } from "../../src/ws/plugin.js";
import { closedWithin, connect, ORIGIN, type RunningApp, startApp } from "../helpers/app.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";

let schema: TestSchema;
let db: Database;
let server: RunningApp;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("chatws"));
  server = await startApp(db);
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

const chatUrl = (base: string, query: string) => `${base}/chat${query}`;
const sessionCount = async () => Number((await db.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n);

/** Polls until the session row exists (the handshake commits after the upgrade completes). */
async function waitForSession(id: string) {
  for (let i = 0; i < 50; i++) {
    const session = await getSession(db.pool, id);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session ${id} was not created`);
}

describe("valid connect", () => {
  it("creates the session lazily on first connect and keeps the socket open", async () => {
    const id = randomUUID();
    expect(await getSession(db.pool, id)).toBeNull();
    const socket = connect(chatUrl(server.ws, `?sessionId=${id}`));
    await socket.opened;
    const session = await waitForSession(id);
    expect(session.status).toBe("active");
    expect(await listEvents(db.pool, id)).toMatchObject([{ seq: 1, type: "session.created", payload: { via: "chat" } }]);
    expect(await closedWithin(socket, 300)).toBe("open");
    socket.ws.close();
  });

  it("a reconnect (or a second tab) loads the same session without creating anything", async () => {
    const id = randomUUID();
    const first = connect(chatUrl(server.ws, `?sessionId=${id}`));
    await first.opened;
    await waitForSession(id);
    const second = connect(chatUrl(server.ws, `?sessionId=${id}`));
    await second.opened;
    expect(await closedWithin(second, 200)).toBe("open");
    expect(await listEvents(db.pool, id)).toHaveLength(1);
    first.ws.close();
    second.ws.close();
  });

  it("treats an uppercase id as the same (canonical lowercase) session", async () => {
    const id = randomUUID();
    const socket = connect(chatUrl(server.ws, `?sessionId=${id.toUpperCase()}`));
    await socket.opened;
    await waitForSession(id);
    expect(await closedWithin(socket, 200)).toBe("open");
    socket.ws.close();
  });

  it("drops malformed client messages and stays open (P3-T04: only the replay is sent)", async () => {
    const socket = connect(chatUrl(server.ws, `?sessionId=${randomUUID()}`));
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: "x" })); // no field or value
    socket.ws.send("not json");
    socket.ws.send(JSON.stringify({ type: "somethingNew" }));
    expect(await closedWithin(socket, 300)).toBe("open");
    // A new session's replay: its state and the end of the replay, nothing in reply to the bad messages.
    expect(socket.messages.map((m) => (m as { type: string }).type)).toEqual(["sessionState", "syncDone"]);
    socket.ws.close();
  });
});

describe("refusals: the upgrade completes, then the server closes with a code and reason", () => {
  it("closes 4400 for a malformed, missing or repeated session id, creating nothing", async () => {
    const before = await sessionCount();
    const valid = randomUUID();
    for (const query of ["?sessionId=abc", "", "?sessionId=", `?sessionId=${valid}x`, `?sessionId=${valid}&sessionId=${randomUUID()}`, `?sessionid=${valid}`]) {
      const socket = connect(chatUrl(server.ws, query));
      await socket.opened; // the browser sees onopen, then the reason (protocol.md §6)
      expect(await socket.closed, query).toEqual({ code: 4400, reason: "invalid session id" });
    }
    expect(await sessionCount()).toBe(before);
  });

  it("closes 4403 for a foreign or missing Origin, before touching the session", async () => {
    const before = await sessionCount();
    for (const origin of ["https://evil.example.com", "http://repair.example.com", `${ORIGIN}:443`, `${ORIGIN}/`, "null", null]) {
      const id = randomUUID();
      const socket = connect(chatUrl(server.ws, `?sessionId=${id}`), { origin });
      expect(await socket.closed, String(origin)).toEqual({ code: 4403, reason: "origin not allowed" });
      expect(await getSession(db.pool, id)).toBeNull();
    }
    expect(await sessionCount()).toBe(before);
  });

  it("closes 1011 when the database is unreachable (the client retries)", async () => {
    const down = createDatabase({ connectionString: "postgresql://nobody@127.0.0.1:1/none", onError: () => {} });
    const broken = await startApp(down);
    try {
      const socket = connect(chatUrl(broken.ws, `?sessionId=${randomUUID()}`));
      expect(await socket.closed).toEqual({ code: 1011, reason: "server error" });
    } finally {
      await broken.close();
      await down.pool.end();
    }
  });

  it("closes 1009 for a message over 64 KB", async () => {
    const socket = connect(chatUrl(server.ws, `?sessionId=${randomUUID()}`));
    await socket.opened;
    socket.ws.send("x".repeat(64 * 1024 + 1));
    expect((await socket.closed).code).toBe(1009);
  });

  it("answers a plain HTTP GET /chat (no upgrade) with the JSON 404", async () => {
    const res = await server.app.inject({ method: "GET", url: `/chat?sessionId=${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("new-session rate limit per client IP", () => {
  it("closes 4429 beyond the limit; existing sessions still connect", async () => {
    const limited = await startApp(db, { newSessionsPerIpPerHour: 2 });
    try {
      const ids = [randomUUID(), randomUUID()];
      for (const id of ids) {
        const socket = connect(chatUrl(limited.ws, `?sessionId=${id}`));
        await socket.opened;
        await waitForSession(id);
        socket.ws.close();
      }
      const refusedId = randomUUID();
      const refused = connect(chatUrl(limited.ws, `?sessionId=${refusedId}`));
      expect(await refused.closed).toEqual({ code: 4429, reason: "rate limited" });
      expect(await getSession(db.pool, refusedId)).toBeNull();

      const again = connect(chatUrl(limited.ws, `?sessionId=${ids[0]}`));
      await again.opened;
      expect(await closedWithin(again, 200)).toBe("open");
      again.ws.close();
    } finally {
      await limited.close();
    }
  });

  it("keys on the forwarded client IP only when proxy hops are trusted", async () => {
    // Trusting one hop: each X-Forwarded-For client gets its own budget.
    const behindProxy = await startApp(db, { newSessionsPerIpPerHour: 1, trustProxyHops: 1 });
    // Trusting none: the header is ignored, so both share the socket address's budget.
    const direct = await startApp(db, { newSessionsPerIpPerHour: 1 });
    try {
      const open = async (base: string, forwardedFor: string) => {
        const socket = connect(chatUrl(base, `?sessionId=${randomUUID()}`), { headers: { "x-forwarded-for": forwardedFor } });
        const result = await closedWithin(socket, 300);
        socket.ws.close();
        return result === "open" ? "open" : result.code;
      };
      expect(await open(behindProxy.ws, "203.0.113.1")).toBe("open");
      expect(await open(behindProxy.ws, "203.0.113.2")).toBe("open");
      expect(await open(behindProxy.ws, "203.0.113.1")).toBe(4429);
      // A client can't escape by prepending its own entry: only the hop nearest the trusted proxy counts.
      expect(await open(behindProxy.ws, "198.51.100.9, 203.0.113.1")).toBe(4429);

      expect(await open(direct.ws, "203.0.113.1")).toBe("open");
      expect(await open(direct.ws, "203.0.113.2")).toBe(4429);
    } finally {
      await behindProxy.close();
      await direct.close();
    }
  });
});

describe("keepalive and shutdown", () => {
  it("terminates a client that stops answering pings, and keeps one that answers", async () => {
    const fast = await startApp(db, { keepAlive: { intervalMs: 50, maxMissed: 2 } });
    try {
      const silent = connect(chatUrl(fast.ws, `?sessionId=${randomUUID()}`), { autoPong: false });
      const healthy = connect(chatUrl(fast.ws, `?sessionId=${randomUUID()}`));
      await Promise.all([silent.opened, healthy.opened]);
      const silentClose = await closedWithin(silent, 1_000);
      expect(silentClose).not.toBe("open");
      expect((silentClose as { code: number }).code).toBe(1006); // terminated, no close frame
      expect(await closedWithin(healthy, 200)).toBe("open");
      healthy.ws.close();
    } finally {
      await fast.close();
    }
  });

  it("closes open sockets with 1012 'server restarting' when the server shuts down", async () => {
    const closing = await startApp(db);
    const socket = connect(chatUrl(closing.ws, `?sessionId=${randomUUID()}`));
    await socket.opened;
    await closedWithin(socket, 100); // let the handshake finish
    const [closed] = await Promise.all([socket.closed, closing.close()]);
    expect(closed).toEqual({ code: 1012, reason: "server restarting" });
  });

  it("drops a client that never answers the close, so shutdown ends after the grace period, not ws's 30 s", async () => {
    const closing = await startApp(db);
    const id = randomUUID();
    const port = Number(new URL(closing.http).port);
    // A raw TCP client that completes the upgrade and then never reads or answers anything.
    const raw = tcpConnect(port, "127.0.0.1");
    raw.on("error", () => {});
    raw.write(
      [
        `GET /chat?sessionId=${id} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${ORIGIN}`,
        "",
        "",
      ].join("\r\n"),
    );
    try {
      await waitForSession(id);
      const started = Date.now();
      await closing.close();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_CLOSE_GRACE_MS - 100);
      expect(elapsed).toBeLessThan(SHUTDOWN_CLOSE_GRACE_MS + 1_500);
    } finally {
      raw.destroy();
    }
  }, 15_000);
});
