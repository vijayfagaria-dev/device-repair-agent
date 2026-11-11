// The cost and latency report (P11-T03) on a seeded database: exact numbers, the completed-only and real/synthetic
// splits, the gate, the arguments, and the command line itself (a real run of the script against the test Postgres).
// It proves the script's arithmetic and wiring; it says nothing about the deployed system (no such run exists yet).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertCall } from "../../src/db/repos/calls.js";
import { upsertTurnMetric } from "../../src/db/repos/turnMetrics.js";
import { collect, GATE, median, parseArgs, percentile, renderMarkdown, type ReportOptions, summarize, UsageError } from "../../scripts/report.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/report.ts", import.meta.url));

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("report"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const NOW = new Date("2026-11-20T12:00:00.000Z");
const options = (extra: Partial<ReportOptions> = {}): ReportOptions => ({ region: "Render Virginia, user in India", browsers: "Chrome 131", headphones: "yes", synthetic: new Set(), now: NOW, ...extra });

async function session(status: "active" | "finalized", outcome: string | null, createdAt = "2026-11-15T10:00:00Z"): Promise<string> {
  const id = await seedSession(pool);
  await pool.query("UPDATE sessions SET status = $2, outcome = $3, created_at = $4 WHERE id = $1", [id, status, outcome, createdAt]);
  return id;
}
const usage = (sessionId: string, provider: string, kind: string, units: number, costUsd: number) =>
  pool.query("INSERT INTO usage (session_id, provider, kind, units, unit, cost_usd) VALUES ($1, $2, $3, $4, 'unit', $5)", [sessionId, provider, kind, units, costUsd]);

/** A completed session: Deepgram i·0.001, Groq 0.0005, two LLM requests of which the second read the cache. */
async function completedWithLedger(i: number, createdAt?: string): Promise<string> {
  const id = await session("finalized", "completed", createdAt);
  await usage(id, "deepgram", "nova-3:audio", 60, i * 0.001);
  await usage(id, "groq", "openai/gpt-oss-20b:output", 100, 0.0005);
  await usage(id, "groq", "openai/gpt-oss-20b:requests", 1, 0);
  await usage(id, "groq", "openai/gpt-oss-20b:requests", 1, 0);
  await usage(id, "groq", "openai/gpt-oss-20b:cachedInput", 800, 0);
  return id;
}

/** `count` replies to the user, server ms from `first`, stt 300, one ttft/ttfb, a browser number on every other turn. */
async function turns(sessionId: string, callId: string, count: number, first: number): Promise<void> {
  await insertCall(pool, { id: callId, sessionId });
  for (let k = 0; k < count; k++) {
    await upsertTurnMetric(pool, {
      turnId: `ta_${callId}_${k + 2}`,
      sessionId,
      callId,
      userEndAt: new Date("2026-11-15T10:01:00Z"),
      serverMs: first + k,
      sttMs: 300,
      llmTtftMs: 400,
      ttsTtfbMs: 200,
      ...(k % 2 === 0 ? { clientMs: first + k + 500 } : {}),
    });
  }
}

describe("statistics", () => {
  it("percentile is nearest rank: an observed value", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(hundred, 50), percentile(hundred, 95), percentile([10, 20, 30], 50), percentile([10, 20, 30], 95), percentile([7], 95), percentile([], 50)]).toEqual([50, 95, 20, 30, 7, null]);
  });
  it("summarize ignores non-finite values and handles nothing", () => {
    expect(summarize([300, 100, Number.NaN, 200, Number.POSITIVE_INFINITY])).toEqual({ n: 3, p50: 200, p95: 300, mean: 200, min: 100, max: 300 });
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, mean: null, min: null, max: null });
  });
  it("median averages the middle pair of an even count", () => {
    expect([median([3, 1, 2]), median([4, 1, 3, 2]), median([])]).toEqual([2, 2.5, null]);
  });
});

describe("collect + renderMarkdown on a seeded database", () => {
  let synthetic: string;
  let data: Awaited<ReturnType<typeof collect>>;

  beforeAll(async () => {
    // 12 completed real sessions with 5 replies each (60 turns), a ledger each.
    for (let i = 1; i <= 12; i++) {
      const id = await completedWithLedger(i);
      await turns(id, `c_real_${i}`, 5, 1_000 + (i - 1) * 5);
    }
    // Not completed: active with spend, opted out, and a finalized-but-partial one. Their turns still count for latency.
    const active = await session("active", null);
    await usage(active, "deepgram", "nova-3:audio", 60, 9);
    await turns(active, "c_active", 2, 5_000);
    await usage(await session("finalized", "optedOut"), "deepgram", "nova-3:audio", 60, 9);
    await usage(await session("finalized", "partial"), "deepgram", "nova-3:audio", 60, 9);
    // Outside the window.
    await completedWithLedger(100, "2026-10-01T00:00:00Z");
    // Synthetic runs: two completed.
    synthetic = await completedWithLedger(50);
    await turns(synthetic, "c_synth", 3, 9_000);
    // A client-only row for a turn the server never recorded: left out of the latency numbers.
    const real = await session("finalized", "completed");
    await insertCall(pool, { id: "c_clientonly", sessionId: real });
    await upsertTurnMetric(pool, { turnId: "ta_c_clientonly_2", sessionId: real, callId: "c_clientonly", clientMs: 777 });
    data = await collect(pool, options({ from: new Date("2026-11-01T00:00:00Z"), synthetic: new Set([synthetic]) }));
  });

  it("cost: completed real sessions only, exact mean, median and per-provider split", () => {
    const deepgram = Array.from({ length: 12 }, (_, i) => (i + 1) * 0.001);
    const totals = [...deepgram.map((d) => d + 0.0005), 0]; // the 13th completed session (client-only turn) has no ledger
    const c = data.real.cost;
    expect(c.sessions).toBe(13);
    expect(c.meanUsd).toBeCloseTo(totals.reduce((a, b) => a + b, 0) / 13, 9);
    expect(c.medianUsd).toBeCloseTo(0.0065, 9); // sorted: 0, .0015 … .0125: the 7th value
    expect(c.minUsd).toBe(0);
    expect(c.maxUsd).toBeCloseTo(0.0125, 9);
    expect(c.byProviderUsd.deepgram).toBeCloseTo(deepgram.reduce((a, b) => a + b, 0) / 13, 9);
    expect(c.byProviderUsd.groq).toBeCloseTo((12 * 0.0005) / 13, 9);
    expect(Object.keys(c.byProviderUsd).sort()).toEqual(["deepgram", "groq"]); // the 9-dollar sessions never entered
  });

  it("cache reads are counted from the ledger", () => {
    expect(data.real.cost).toMatchObject({ llmRequests: 24, cacheReadRequests: 12, sessionsWithCacheRead: 12 });
  });

  it("latency: every reply with a server number (completed or not), exact p50/p95, stage timings, browser number apart", () => {
    const l = data.real.latency;
    // 60 turns 1000…1295 in steps for each call, plus the active session's 2 turns at 5000.
    expect(l.turns).toBe(62);
    expect(l.calls).toBe(13);
    const server = [...Array.from({ length: 12 }, (_, i) => Array.from({ length: 5 }, (_, k) => 1_000 + i * 5 + k)).flat(), 5_000, 5_001].sort((a, b) => a - b);
    expect(l.serverMs).toMatchObject({ n: 62, p50: server[30], p95: server[58], min: 1_000, max: 5_001 });
    expect(l.sttMs).toMatchObject({ n: 62, p50: 300, p95: 300 });
    expect(l.llmTtftMs.p50).toBe(400);
    expect(l.ttsTtfbMs.p50).toBe(200);
    expect(l.clientMs.n).toBe(12 * 3 + 1); // turns 0, 2, 4 of each call of 5, and the active session's first turn
    expect(l.clientMs.max).not.toBe(777);
  });

  it("window and synthetic list: the old session is out, synthetic runs are reported apart", () => {
    expect(data.real.sessions).toBe(12 + 3 + 1);
    expect(data.synthetic.sessions).toBe(1);
    expect(data.synthetic.cost).toMatchObject({ sessions: 1 });
    expect(data.synthetic.cost.meanUsd).toBeCloseTo(0.0505, 9);
    expect(data.synthetic.latency).toMatchObject({ turns: 3, calls: 1 });
    expect(data.synthetic.latency.serverMs.p50).toBe(9_001);
  });

  it("the markdown states n, dates, region, browsers, headphones, the method and the gate", () => {
    const md = renderMarkdown(data);
    for (const text of ["Region: Render Virginia, user in India.", "Browsers: Chrome 131.", "Headphones: yes.", "Window: sessions created 2026-11-01 to now.", "n = 13 completed sessions", "n = 62 turns across 13 calls", "## Method", "nearest rank", "Synthetic runs (reported separately)", "Generated 2026-11-20T12:00:00.000Z"]) {
      expect(md).toContain(text);
    }
    expect(md).toContain(`Cost: n ≥ ${GATE.completedSessions} completed sessions: **met** (n = 13)`);
    expect(md).toContain(`Latency: n ≥ ${GATE.turns} turns: **met** (n = 62)`);
  });

  it("says the gate is NOT met with too few samples, and prints the n it has", async () => {
    const small = await collect(pool, options({ from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") }));
    const md = renderMarkdown(small);
    expect(md).toContain("No completed sessions.");
    expect(md).toContain("**NOT met** (n = 0)");
    expect(md).toContain("n/a");
  });

  it("headphones: no is stated with its caveat, and cell text can't break the table", () => {
    const md = renderMarkdown({ ...data, options: options({ headphones: "no", region: "a | b\nc" }) });
    expect(md).toContain("Headphones: no. Speaker echo");
    expect(md).toContain("Region: a b c.");
  });
});

describe("parseArgs", () => {
  const ok = ["--region", "Virginia", "--browsers", "Chrome", "--headphones", "no"];
  it("reads the required conditions and the optional window and synthetic list", () => {
    const id = randomUUID();
    const { options: o, out } = parseArgs([...ok, "--from", "2026-11-01", "--to", "2026-11-09", "--synthetic-file", "s.txt", "--out", "r.md"], NOW, () => `# runs\n${id.toUpperCase()}\n\n${id} # again\n`);
    expect(o).toMatchObject({ region: "Virginia", browsers: "Chrome", headphones: "no", now: NOW });
    expect(o.from?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect([...o.synthetic]).toEqual([id]);
    expect(out).toBe("r.md");
  });
  it("refuses a missing condition, a bad value, an unknown flag and a bad synthetic file", () => {
    const bad = (argv: string[], read = () => "") => expect(() => parseArgs(argv, NOW, read)).toThrow(UsageError);
    bad(["--browsers", "Chrome", "--headphones", "no"]);
    bad(["--region", "  ", "--browsers", "Chrome", "--headphones", "no"]);
    bad([...ok.slice(0, 4), "--headphones", "maybe"]);
    bad([...ok, "--from", "yesterday-ish"]);
    bad([...ok, "--database-url", "x"]);
    bad([...ok, "--out"]);
    bad([...ok, "--synthetic-file", "s.txt"], () => "not-a-uuid\n");
    bad([...ok, "--synthetic-file", "missing.txt"], () => {
      throw new Error("ENOENT");
    });
  });
});

describe("the command line", () => {
  const cli = (args: string[], env: Record<string, string>) => run("node", [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
  );
  const conditions = ["--region", "Virginia", "--browsers", "Chrome", "--headphones", "yes"];

  it("prints the report for DATABASE_URL, reading only", async () => {
    const id = await completedWithLedger(1, "2026-12-25T00:00:00Z");
    await turns(id, "c_cli", 2, 1_234);
    const result = await cli([...conditions, "--from", "2026-12-24"], { DATABASE_URL: schema.url });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("n = 1 completed sessions");
    expect(result.out).toContain("n = 2 turns across 1 calls");
    expect(result.out).toContain("1235 ms"); // p95 of 1234, 1235
  });

  it("exits 2 on bad arguments or no DATABASE_URL, and never prints the URL", async () => {
    const noCondition = await cli([], { DATABASE_URL: schema.url });
    expect(noCondition.code).toBe(2);
    expect(noCondition.err).toContain("--region is required");
    const noUrl = await cli(conditions, {});
    expect(noUrl.code).toBe(2);
    expect(noUrl.err).toContain("DATABASE_URL is not set");
    const unreachable = "postgres://user:secret-pass@127.0.0.1:1/db";
    const failed = await cli(conditions, { DATABASE_URL: unreachable });
    expect(failed.code).toBe(1);
    expect(failed.err + failed.out).not.toContain("secret-pass");
  });
});
