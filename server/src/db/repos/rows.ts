// Shared pieces of the repository layer: zod parsers for what `pg` returns, and row validation on read.
// Every row read from the database is parsed, so a schema/code mismatch fails loudly at the boundary.
import { z } from "zod";

/** Any JSON value (jsonb columns). */
export const json = z.json();
/** A JSON object (jsonb columns that always hold an object). */
export const jsonObject = z.record(z.string(), z.json());
export type JsonValue = z.infer<typeof json>;
export type JsonObject = z.infer<typeof jsonObject>;

export const int = z.number().int();
/** `bigint` identity columns arrive as strings; they stay far below 2^53. */
export const bigintId = z
  .union([z.string().regex(/^\d+$/), z.number().int()])
  .transform(Number)
  .refine(Number.isSafeInteger, "id exceeds the safe integer range");
/** `numeric` columns arrive as strings to keep precision; usage amounts fit a double. */
export const numeric = z
  .string()
  .transform(Number)
  .refine(Number.isFinite, "not a finite number");
export const timestamp = z.date();

export class RowShapeError extends Error {
  constructor(table: string, error: z.ZodError) {
    // Issue paths and messages only: zod 4 doesn't echo input values, so no row content reaches the logs.
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "(row)"}: ${issue.message}`).join("; ");
    super(`Unexpected ${table} row shape: ${issues}`);
    this.name = "RowShapeError";
  }
}

export function parseRow<T>(table: string, schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) throw new RowShapeError(table, result.error);
  return result.data;
}

export function parseRows<T>(table: string, schema: z.ZodType<T>, rows: unknown[]): T[] {
  return rows.map((row) => parseRow(table, schema, row));
}

export function parseOptionalRow<T>(table: string, schema: z.ZodType<T>, rows: unknown[]): T | null {
  return rows[0] === undefined ? null : parseRow(table, schema, rows[0]);
}

/** The row from an `INSERT … RETURNING` that always returns one. */
export function parseReturnedRow<T>(table: string, schema: z.ZodType<T>, rows: unknown[]): T {
  if (rows[0] === undefined) throw new Error(`${table}: the statement returned no row`);
  return parseRow(table, schema, rows[0]);
}

/** jsonb parameters are sent as JSON text: `pg` would turn a JS array into a Postgres array literal. */
export function toJsonParam(value: unknown): string {
  return JSON.stringify(value);
}

export function toOptionalJsonParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Positive integer for LIMIT, validated before it reaches SQL. */
export function checkLimit(limit: number, max = 1_000): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new RangeError(`limit must be an integer from 1 to ${max}`);
  return limit;
}
