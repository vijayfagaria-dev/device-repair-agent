// usage: the provider usage ledger. Cost math and daily counters come with P3-T07; this is the data access.
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { bigintId, numeric, parseReturnedRow, parseRows, timestamp } from "./rows.js";

const usageSchema = z.object({
  id: bigintId,
  sessionId: z.string(),
  provider: z.string(),
  kind: z.string(),
  units: numeric,
  unit: z.string(),
  costUsd: numeric,
  at: timestamp,
});
export type UsageEntry = z.infer<typeof usageSchema>;

export interface NewUsageEntry {
  sessionId: string;
  provider: string;
  kind: string;
  units: number;
  unit: string;
  costUsd?: number;
  at?: Date;
}

const COLUMNS = `id, session_id AS "sessionId", provider, kind, units, unit, cost_usd AS "costUsd", at`;

export async function insertUsage(db: Queryable, entry: NewUsageEntry): Promise<UsageEntry> {
  for (const [name, value] of [
    ["units", entry.units],
    ["costUsd", entry.costUsd ?? 0],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number ≥ 0`);
  }
  const { rows } = await db.query(
    `INSERT INTO usage (session_id, provider, kind, units, unit, cost_usd, at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     RETURNING ${COLUMNS}`,
    [entry.sessionId, entry.provider, entry.kind, entry.units, entry.unit, entry.costUsd ?? 0, entry.at ?? null],
  );
  return parseReturnedRow("usage", usageSchema, rows);
}

export async function listUsage(db: Queryable, sessionId: string): Promise<UsageEntry[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM usage WHERE session_id = $1 ORDER BY at, id`, [sessionId]);
  return parseRows("usage", usageSchema, rows);
}
