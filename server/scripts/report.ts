// Cost and latency report (P11-T03, D20): reads the production database, read-only, and prints a markdown report.
// Plain Node 22 (type stripping), no build:
//
//   DATABASE_URL=<Neon URL> node scripts/report.ts --region "Render Virginia / user in India" --browsers "Chrome 131" \
//     --headphones yes [--from 2026-11-12] [--to 2026-11-20] [--synthetic-file synthetic-sessions.txt] [--out report.md]
//
// What it says and doesn't:
//  * Cost: completed sessions only (`sessions.status = 'finalized'`, `outcome = 'completed'`), the list-price equivalent
//    summed from the usage ledger (actual spend is $0 on the free tiers). Mean, median, and the per-provider split.
//  * Latency: every agent turn that follows a user utterance (server ms = STT's end-of-utterance event → first audio frame
//    written to the socket), p50/p95 by nearest rank (an observed value, never interpolated), plus the stage timings and
//    the browser's own number, reported separately.
//  * Real-user and synthetic sessions are reported apart. The database can't tell them apart, so the operator lists the
//    synthetic session ids (one per line) in --synthetic-file; everything else counts as a real user.
//  * Region, browsers and headphones are not in the database: they are required arguments and are printed as given.
//  * Nothing here is an estimate. With too few samples the report prints the numbers it has, says n, and says the gate
//    is not met.
//
// DATABASE_URL comes from the environment only and is never printed. Exit 0 with the report on stdout (or in --out);
// 2 for bad arguments.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** The P11 gate (implementation plan): enough completed real-user sessions and real-user turns. */
export const GATE = { completedSessions: 10, turns: 50 } as const;

export interface ReportOptions {
  region: string;
  browsers: string;
  headphones: "yes" | "no";
  /** Sessions created from this instant (inclusive), or all. */
  from?: Date;
  /** Sessions created before this instant (exclusive), or all. */
  to?: Date;
  /** Session ids to report as synthetic runs. */
  synthetic: ReadonlySet<string>;
  /** When the report was generated (printed). */
  now: Date;
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface CostGroup {
  /** Completed sessions with a ledger. */
  sessions: number;
  meanUsd: number | null;
  medianUsd: number | null;
  minUsd: number | null;
  maxUsd: number | null;
  /** Mean list-price cost per completed session, by provider. */
  byProviderUsd: Record<string, number>;
  /** LLM requests with cache reads, of all LLM requests, and the sessions with at least one cache read. */
  llmRequests: number;
  cacheReadRequests: number;
  sessionsWithCacheRead: number;
}

export interface LatencyGroup {
  turns: number;
  calls: number;
  serverMs: Summary;
  sttMs: Summary;
  llmTtftMs: Summary;
  ttsTtfbMs: Summary;
  /** The browser's number, for the turns that have one. */
  clientMs: Summary;
}

export interface GroupData {
  sessions: number;
  completedSessions: number;
  firstSessionAt: Date | null;
  lastSessionAt: Date | null;
  cost: CostGroup;
  latency: LatencyGroup;
}

export interface ReportData {
  options: ReportOptions;
  real: GroupData;
  synthetic: GroupData;
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics

/** Nearest-rank percentile of an ascending list: an observed value. Null for an empty list. */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAscending[rank - 1] ?? null;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: n === 0 ? null : sorted.reduce((sum, v) => sum + v, 0) / n,
    min: sorted[0] ?? null,
    max: sorted[n - 1] ?? null,
  };
}

/** The usual median (the mean of the two middle values for an even count), for costs. */
export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------------------------------------------------
// Collection

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

interface SessionRow {
  id: string;
  status: string;
  outcome: string | null;
  createdAt: Date;
}

export async function collect(db: Queryable, options: ReportOptions): Promise<ReportData> {
  const { rows: sessions } = await db.query<SessionRow>(
    `SELECT id, status, outcome, created_at AS "createdAt" FROM sessions
      WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at`,
    [options.from ?? null, options.to ?? null],
  );
  const isSynthetic = (id: string) => options.synthetic.has(id);
  return {
    options,
    real: await group(db, sessions.filter((s) => !isSynthetic(s.id))),
    synthetic: await group(db, sessions.filter((s) => isSynthetic(s.id))),
  };
}

async function group(db: Queryable, sessions: SessionRow[]): Promise<GroupData> {
  const ids = sessions.map((s) => s.id);
  const completed = sessions.filter((s) => s.status === "finalized" && s.outcome === "completed").map((s) => s.id);
  return {
    sessions: sessions.length,
    completedSessions: completed.length,
    firstSessionAt: sessions[0]?.createdAt ?? null,
    lastSessionAt: sessions.at(-1)?.createdAt ?? null,
    cost: await costGroup(db, completed),
    latency: await latencyGroup(db, ids),
  };
}

async function costGroup(db: Queryable, completed: string[]): Promise<CostGroup> {
  // Every completed session counts, with 0 when its ledger is empty (a session that cost nothing is still a session).
  const { rows: perSession } = await db.query<{ id: string; total: string }>(
    `SELECT s.id, COALESCE(sum(u.cost_usd), 0)::text AS total
       FROM sessions s LEFT JOIN usage u ON u.session_id = s.id
      WHERE s.id = ANY($1::uuid[]) GROUP BY s.id`,
    [completed],
  );
  const totals = perSession.map((r) => Number(r.total));
  const { rows: providers } = await db.query<{ provider: string; total: string }>(
    "SELECT provider, sum(cost_usd)::text AS total FROM usage WHERE session_id = ANY($1::uuid[]) GROUP BY provider ORDER BY provider",
    [completed],
  );
  const byProviderUsd: Record<string, number> = {};
  for (const row of providers) byProviderUsd[row.provider] = Number(row.total) / Math.max(1, completed.length);
  const { rows: cache } = await db.query<{ requests: string; cached: string; sessions: string }>(
    `SELECT count(*) FILTER (WHERE kind LIKE '%:requests')::text AS requests,
            count(*) FILTER (WHERE kind LIKE '%:cachedInput' AND units > 0)::text AS cached,
            count(DISTINCT session_id) FILTER (WHERE kind LIKE '%:cachedInput' AND units > 0)::text AS sessions
       FROM usage WHERE session_id = ANY($1::uuid[])`,
    [completed],
  );
  return {
    sessions: totals.length,
    meanUsd: totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0) / totals.length,
    medianUsd: median(totals),
    minUsd: totals.length === 0 ? null : Math.min(...totals),
    maxUsd: totals.length === 0 ? null : Math.max(...totals),
    byProviderUsd,
    llmRequests: Number(cache[0]?.requests ?? 0),
    cacheReadRequests: Number(cache[0]?.cached ?? 0),
    sessionsWithCacheRead: Number(cache[0]?.sessions ?? 0),
  };
}

async function latencyGroup(db: Queryable, ids: string[]): Promise<LatencyGroup> {
  // Turns that follow a user utterance have a server number; a row with only a client number has no server side to
  // compare with (a client sample for a turn that never got a row) and is left out.
  const { rows } = await db.query<{ call_id: string; server_ms: number; stt_ms: number | null; llm_ttft_ms: number | null; tts_ttfb_ms: number | null; client_ms: number | null }>(
    `SELECT call_id, server_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms, client_ms FROM turn_metrics
      WHERE session_id = ANY($1::uuid[]) AND server_ms IS NOT NULL`,
    [ids],
  );
  const column = (name: "stt_ms" | "llm_ttft_ms" | "tts_ttfb_ms" | "client_ms") => rows.map((r) => r[name]).filter((v): v is number => v !== null);
  return {
    turns: rows.length,
    calls: new Set(rows.map((r) => r.call_id)).size,
    serverMs: summarize(rows.map((r) => r.server_ms)),
    sttMs: summarize(column("stt_ms")),
    llmTtftMs: summarize(column("llm_ttft_ms")),
    ttsTtfbMs: summarize(column("tts_ttfb_ms")),
    clientMs: summarize(column("client_ms")),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown

const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(6)}`);
const ms = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)} ms`);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "n/a");
const cell = (text: string) => text.replace(/[|\s]+/g, " ").trim();

function latencyTable(l: LatencyGroup): string {
  const row = (label: string, s: Summary) => `| ${label} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.mean)} | ${ms(s.min)} | ${ms(s.max)} |`;
  return [
    "| Stage | n | p50 | p95 | mean | min | max |",
    "|---|---|---|---|---|---|---|",
    row("**Server: STT end-of-utterance → first audio frame sent**", l.serverMs),
    row("STT: end-of-utterance event → turn starts (merge window)", l.sttMs),
    row("LLM: first token", l.llmTtftMs),
    row("TTS: first text sent → first audio byte", l.ttsTtfbMs),
    row("Browser: mic speech end → first audio scheduled (secondary)", l.clientMs),
  ].join("\n");
}

function groupSection(title: string, g: GroupData, gate: boolean): string {
  const lines = [`## ${title}`, ""];
  lines.push(`Sessions in the window: ${g.sessions} (${day(g.firstSessionAt)} to ${day(g.lastSessionAt)}); completed: ${g.completedSessions}.`, "");
  lines.push("### Cost per completed session (list-price equivalent; actual spend $0)", "");
  const c = g.cost;
  if (c.sessions === 0) {
    lines.push("No completed sessions.", "");
  } else {
    lines.push(`n = ${c.sessions} completed sessions. Mean ${usd(c.meanUsd)}, median ${usd(c.medianUsd)}, min ${usd(c.minUsd)}, max ${usd(c.maxUsd)}.`, "");
    lines.push("| Provider | Mean per session |", "|---|---|");
    for (const [provider, value] of Object.entries(c.byProviderUsd)) lines.push(`| ${cell(provider)} | ${usd(value)} |`);
    lines.push("");
    lines.push(`Prompt cache: ${c.cacheReadRequests} of ${c.llmRequests} LLM requests read from the cache; ${c.sessionsWithCacheRead} of ${c.sessions} sessions had at least one cache read. (The first request of each session starts cold.)`, "");
  }
  lines.push("### Voice latency", "");
  const l = g.latency;
  lines.push(`n = ${l.turns} turns across ${l.calls} calls.`, "", latencyTable(l), "");
  if (gate) {
    const sessionsOk = c.sessions >= GATE.completedSessions;
    const turnsOk = l.turns >= GATE.turns;
    lines.push(
      "### P11 gate",
      "",
      `- Cost: n ≥ ${GATE.completedSessions} completed sessions: **${sessionsOk ? "met" : "NOT met"}** (n = ${c.sessions}).`,
      `- Latency: n ≥ ${GATE.turns} turns: **${turnsOk ? "met" : "NOT met"}** (n = ${l.turns}).`,
      "",
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(data: ReportData): string {
  const o = data.options;
  const window = `${o.from ? day(o.from) : "the start"} to ${o.to ? day(o.to) : "now"}`;
  return [
    "# Cost and latency measurements",
    "",
    `Generated ${o.now.toISOString()} from the production database by \`server/scripts/report.ts\`.`,
    "",
    "## Conditions",
    "",
    `- Window: sessions created ${window}.`,
    `- Region: ${cell(o.region)}.`,
    `- Browsers: ${cell(o.browsers)}.`,
    `- Headphones: ${o.headphones}.${o.headphones === "no" ? " Speaker echo can distort the browser-side number." : ""}`,
    `- Real-user sessions: ${data.real.sessions}. Synthetic runs (listed by the operator): ${data.synthetic.sessions}, reported separately below.`,
    "",
    "## Method",
    "",
    "- **Cost:** the usage ledger, summed per completed session (`finalized` with outcome `completed`) at each provider's published paid list price (`server/src/metrics/prices.ts`, each with its source and date). It is a list-price equivalent: the deployment runs on free tiers, so actual spend is $0. Neon and Render are $0 at this scale.",
    "- **Server latency (primary):** from the STT end-of-utterance event (Deepgram `speech_final`, with the endpointing delay of the STT settings) to the first TTS audio frame written to the socket, for each agent reply that follows a user utterance. Stage timings are listed beside it: the wait between that event and the turn starting (the merge window), the LLM's first token, and TTS's first byte.",
    "- **Browser latency (secondary):** the browser marks the end of speech when the mic level stays below a threshold for 300 ms, and the first agent audio chunk's scheduled start; it reports the difference. It hears the room, so it is noisy; it is listed apart and only for turns that have it.",
    "- **Percentiles:** nearest rank over the sample, so every p50 and p95 is a value that was observed.",
    "",
    groupSection("Real-user sessions", data.real, true),
    groupSection("Synthetic runs (reported separately)", data.synthetic, false),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line

export class UsageError extends Error {}

const FLAGS = new Set(["region", "browsers", "headphones", "from", "to", "synthetic-file", "out"]);
const REQUIRED = ["region", "browsers", "headphones"] as const;

export function parseArgs(argv: readonly string[], now: Date, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): { options: ReportOptions; out: string | null } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!flag.startsWith("--") || !FLAGS.has(flag.slice(2))) throw new UsageError(`unknown argument: ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    values.set(flag.slice(2), value);
  }
  for (const name of REQUIRED) if (!values.get(name)?.trim()) throw new UsageError(`--${name} is required (it isn't in the database; the report states it)`);
  const headphones = values.get("headphones");
  if (headphones !== "yes" && headphones !== "no") throw new UsageError("--headphones must be yes or no");
  const date = (name: "from" | "to") => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new UsageError(`--${name} is not a date: ${raw}`);
    return parsed;
  };
  const file = values.get("synthetic-file");
  const synthetic = new Set<string>();
  if (file !== undefined) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new UsageError(`cannot read --synthetic-file ${file}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const id = line.replace(/#.*/, "").trim().toLowerCase();
      if (!id) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new UsageError(`--synthetic-file: not a session id: ${id.slice(0, 40)}`);
      synthetic.add(id);
    }
  }
  const from = date("from");
  const to = date("to");
  return {
    options: {
      region: values.get("region") as string,
      browsers: values.get("browsers") as string,
      headphones,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      synthetic,
      now,
    },
    out: values.get("out") ?? null,
  };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2), new Date());
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (the Neon URL, in the shell environment only)");
    return 2;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY"); // the report never writes
    const markdown = renderMarkdown(await collect(client, parsed.options));
    await client.query("ROLLBACK");
    if (parsed.out) writeFileSync(parsed.out, `${markdown}\n`);
    else process.stdout.write(`${markdown}\n`);
  } finally {
    await client.end();
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      // The message only: a connection error can quote the URL.
      console.error(`report failed: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, "<database url>")}`);
      process.exit(1);
    },
  );
}
