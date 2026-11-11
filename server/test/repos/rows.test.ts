// Row validation on read: a row that doesn't match its schema fails loudly, without echoing row content.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bigintId,
  checkLimit,
  numeric,
  parseOptionalRow,
  parseReturnedRow,
  parseRow,
  parseRows,
  RowShapeError,
  toJsonParam,
  toOptionalJsonParam,
} from "../../src/db/repos/rows.js";

const schema = z.object({ id: bigintId, secret: z.string(), amount: numeric });

describe("row parsing", () => {
  it("parseRow converts pg's bigint and numeric strings", () => {
    expect(parseRow("t", schema, { id: "42", secret: "x", amount: "0.00012345" })).toEqual({ id: 42, secret: "x", amount: 0.00012345 });
  });

  it("a wrong shape throws RowShapeError naming the table and column, never the value", () => {
    let error: unknown;
    try {
      parseRow("sessions", schema, { id: "1", secret: 12345, amount: "1" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RowShapeError);
    expect((error as Error).message).toMatch(/^Unexpected sessions row shape: secret: /);
    expect((error as Error).message).not.toContain("12345");
    expect(() => parseRow("t", schema, { id: "9007199254740993", secret: "x", amount: "1" })).toThrow(RowShapeError);
    expect(() => parseRow("t", schema, { id: "1", secret: "x", amount: "NaN" })).toThrow(RowShapeError);
  });

  it("parseRows, parseOptionalRow and parseReturnedRow", () => {
    const row = { id: 1, secret: "s", amount: "2" };
    expect(parseRows("t", schema, [row, row])).toHaveLength(2);
    expect(parseOptionalRow("t", schema, [])).toBeNull();
    expect(parseOptionalRow("t", schema, [row])?.amount).toBe(2);
    expect(parseReturnedRow("t", schema, [row]).id).toBe(1);
    expect(() => parseReturnedRow("t", schema, [])).toThrow(/returned no row/);
  });

  it("JSON parameters are JSON text (arrays stay JSON arrays, not Postgres arrays)", () => {
    expect(toJsonParam(["a", 1])).toBe('["a",1]');
    expect(toOptionalJsonParam(undefined)).toBeNull();
    expect(toOptionalJsonParam(null)).toBeNull();
    expect(toOptionalJsonParam({ a: 1 })).toBe('{"a":1}');
  });

  it("checkLimit accepts 1…max integers only", () => {
    expect(checkLimit(1)).toBe(1);
    expect(checkLimit(1000)).toBe(1000);
    for (const bad of [0, -1, 1.5, 1001, Number.NaN]) expect(() => checkLimit(bad)).toThrow(RangeError);
  });
});
