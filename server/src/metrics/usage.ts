// The usage ledger (D20, P3-T07): one row per billable quantity, priced at insert with the list-price table, so a
// session's list-price-equivalent cost is exactly the sum of its rows. Also the daily counters the quota guard reads
// (P10-T03). Actual spend is always $0 (free tiers, constraint C1) and is reported separately.
import { insertUsage, type UsageEntry } from "../db/repos/usage.js";
import type { Queryable } from "../db/tx.js";
import { type CostCategory, findPrice, listPriceUsd, type UsageProvider } from "./prices.js";

export class UnknownPriceError extends Error {
  constructor(provider: string, kind: string) {
    super(`no list price for ${provider} ${kind}; add it to metrics/prices.ts with its source`);
    this.name = "UnknownPriceError";
  }
}

function priceOf(provider: string, kind: string) {
  const price = findPrice(provider, kind);
  if (!price) throw new UnknownPriceError(provider, kind);
  return price;
}

/**
 * The category of a stored row. Rows carry the unit and cost they were priced with, so reading the ledger never
 * depends on today's price table: a meter retired since (a model switch) still counts. Its category comes from the
 * table while the meter is listed, otherwise from the stored unit.
 */
function categoryOf(row: { provider: string; kind: string; unit: string }): CostCategory {
  const listed = findPrice(row.provider, row.kind);
  if (listed) return listed.category;
  if (row.unit === "second") return "stt";
  if (row.unit === "character") return "tts";
  return "llm";
}

export interface UsageInput {
  sessionId: string;
  provider: UsageProvider;
  /** `<model>:<meter>`, e.g. `nova-3:audio` (seconds) or `aura-2:characters`. */
  kind: string;
  units: number;
  at?: Date;
}

/** Records one meter reading at its list price. Unpriced meters are refused rather than silently costed at $0. */
export async function recordUsage(db: Queryable, input: UsageInput): Promise<UsageEntry> {
  const price = priceOf(input.provider, input.kind);
  return insertUsage(db, {
    sessionId: input.sessionId,
    provider: input.provider,
    kind: input.kind,
    units: input.units,
    unit: price.unit,
    costUsd: listPriceUsd(price, input.units),
    at: input.at,
  });
}

export interface LlmUsageInput {
  sessionId: string;
  provider: "groq" | "gemini";
  model: string;
  /** From the response's `usage`: prompt tokens include the cached ones. */
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  at?: Date;
}

/** One LLM request: its request count, uncached and cached prompt tokens, and completion tokens. */
export async function recordLlmUsage(db: Queryable, input: LlmUsageInput): Promise<UsageEntry[]> {
  const cached = input.cachedTokens ?? 0;
  for (const [name, value] of [
    ["promptTokens", input.promptTokens],
    ["completionTokens", input.completionTokens],
    ["cachedTokens", cached],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number ≥ 0`);
  }
  if (cached > input.promptTokens) throw new RangeError("cachedTokens can't exceed promptTokens");
  const base = { sessionId: input.sessionId, provider: input.provider, at: input.at };
  const meters: [string, number][] = [
    ["requests", 1],
    ["input", input.promptTokens - cached],
    ["output", input.completionTokens],
  ];
  if (cached > 0) meters.push(["cachedInput", cached]);
  const entries: UsageEntry[] = [];
  for (const [meter, units] of meters) entries.push(await recordUsage(db, { ...base, kind: `${input.model}:${meter}`, units }));
  return entries;
}

export interface SessionCost {
  /** List-price equivalent, the record's `costUsd` (architecture §7). */
  costUsd: number;
  costBreakdownUsd: Record<CostCategory, number>;
  /** Always 0 under C1: every provider is on its free tier. */
  actualSpendUsd: number;
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;

/** A session's list-price cost: the exact sum of its ledger rows (summed in Postgres numeric), by category too. */
export async function sessionCost(db: Queryable, sessionId: string): Promise<SessionCost> {
  const { rows } = await db.query<{ provider: string; kind: string; unit: string; total: string }>(
    "SELECT provider, kind, unit, sum(cost_usd)::text AS total FROM usage WHERE session_id = $1 GROUP BY provider, kind, unit",
    [sessionId],
  );
  const total = await db.query<{ total: string }>("SELECT COALESCE(sum(cost_usd), 0)::text AS total FROM usage WHERE session_id = $1", [sessionId]);
  const breakdown: Record<CostCategory, number> = { stt: 0, llm: 0, tts: 0, vision: 0 };
  for (const row of rows) {
    const category = categoryOf(row);
    breakdown[category] = round(breakdown[category] + Number(row.total));
  }
  return { costUsd: Number(total.rows[0]?.total ?? 0), costBreakdownUsd: breakdown, actualSpendUsd: 0 };
}

export interface DailyUsage {
  /** The window's start (UTC day, or `now - 24 h` for the rolling window). */
  day: string;
  /** LLM requests per `<provider>:<model>` (Groq's limits are per model, D06). */
  llmRequests: Record<string, number>;
  audioMinutes: number;
  ttsCharacters: number;
  uploadBytes: number;
}

async function usageBetween(db: Queryable, start: Date, end: Date, label: string): Promise<DailyUsage> {
  const { rows } = await db.query<{ provider: string; kind: string; unit: string; units: string }>(
    "SELECT provider, kind, unit, sum(units)::text AS units FROM usage WHERE at >= $1 AND at < $2 GROUP BY provider, kind, unit",
    [start, end],
  );
  const files = await db.query<{ bytes: string }>("SELECT COALESCE(sum(size), 0)::text AS bytes FROM files WHERE created_at >= $1 AND created_at < $2", [
    start,
    end,
  ]);
  const usage: DailyUsage = { day: label, llmRequests: {}, audioMinutes: 0, ttsCharacters: 0, uploadBytes: Number(files.rows[0]?.bytes ?? 0) };
  for (const row of rows) {
    const units = Number(row.units);
    // By the stored unit, so a meter since dropped from the price table still counts against today's quota.
    if (row.unit === "request") usage.llmRequests[`${row.provider}:${row.kind.slice(0, -":requests".length)}`] = units;
    else if (row.unit === "second") usage.audioMinutes = round(usage.audioMinutes + units / 60);
    else if (row.unit === "character") usage.ttsCharacters += units;
  }
  return usage;
}

/** Usage on the UTC day containing `now`, across all sessions. */
export async function dailyUsage(db: Queryable, now: Date): Promise<DailyUsage> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return usageBetween(db, start, end, start.toISOString().slice(0, 10));
}

/**
 * Usage in the 24 hours before `now` (P10-T03's quota guard input). Providers reset their daily quotas at different
 * boundaries (UTC midnight, Pacific midnight, a rolling window), and the rolling window is never lower than the
 * usage inside any one of them, so the guard errs on the safe side whichever applies.
 */
export async function rollingDayUsage(db: Queryable, now: Date): Promise<DailyUsage> {
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return usageBetween(db, start, new Date(now.getTime() + 1), start.toISOString());
}
