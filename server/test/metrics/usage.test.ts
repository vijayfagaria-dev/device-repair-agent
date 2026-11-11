// The usage ledger and price table (P3-T07; D20): cost math against fixed samples, exact to 6 decimal places;
// every price has a source and a date; the daily counters match the inserted rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { insertUsage, listUsage } from "../../src/db/repos/usage.js";
import { findPrice, listPriceUsd, PRICES } from "../../src/metrics/prices.js";
import { dailyUsage, recordLlmUsage, recordUsage, sessionCost, UnknownPriceError } from "../../src/metrics/usage.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let db: Database;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("usage"));
});
afterAll(async () => {
  await schema.drop();
});

describe("price table", () => {
  it("gives every price a pricing-page source, a check date and a positive per-quantity", () => {
    expect(PRICES.length).toBeGreaterThan(0);
    for (const price of PRICES) {
      expect(price.source, price.kind).toMatch(/^https:\/\/[a-z.]+\.(com|dev)\//);
      expect(price.checkedOn, price.kind).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.per, price.kind).toBeGreaterThan(0);
      expect(price.usd, price.kind).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(PRICES.map((p) => `${p.provider} ${p.kind}`)).size).toBe(PRICES.length);
  });

  it("covers every model in the approved stack (D04–D06): STT, TTS, the LLM primary and both fallbacks", () => {
    for (const [provider, kind] of [
      ["deepgram", "nova-3:audio"],
      ["deepgram", "aura-2:characters"],
      ["groq", "openai/gpt-oss-20b:input"],
      ["groq", "openai/gpt-oss-20b:output"],
      ["groq", "openai/gpt-oss-120b:input"],
      ["gemini", "gemini-flash-lite-latest:output"],
    ] as const) {
      expect(findPrice(provider, kind), kind).not.toBeNull();
    }
  });

  it("computes list-price cost from the published rates", () => {
    expect(listPriceUsd({ usd: 0.0077, per: 60 }, 60)).toBe(0.0077); // one minute of Nova-3
    expect(listPriceUsd({ usd: 0.03, per: 1000 }, 1000)).toBe(0.03); // 1,000 Aura-2 characters
    expect(listPriceUsd({ usd: 0.3, per: 1_000_000 }, 1)).toBe(0.0000003); // one token is still counted
    expect(listPriceUsd({ usd: 1, per: 3 }, 1)).toBe(0.33333333); // rounded to the ledger's 8 decimals
  });
});

describe("ledger", () => {
  it("prices each row at insert, and the session cost is exactly the sum of its rows (to 6 decimal places)", async () => {
    const sessionId = await seedSession(db.pool);
    // A fixed sample session: ~3.5 minutes of audio, 1,840 TTS characters, 6 LLM requests, one of them on the fallback.
    await recordUsage(db.pool, { sessionId, provider: "deepgram", kind: "nova-3:audio", units: 212.4 });
    await recordUsage(db.pool, { sessionId, provider: "deepgram", kind: "aura-2:characters", units: 1840 });
    for (let i = 0; i < 5; i++) {
      await recordLlmUsage(db.pool, { sessionId, provider: "groq", model: "openai/gpt-oss-20b", promptTokens: 1800 + i, completionTokens: 120, cachedTokens: 1024 });
    }
    await recordLlmUsage(db.pool, { sessionId, provider: "groq", model: "openai/gpt-oss-120b", promptTokens: 1900, completionTokens: 150 });

    // Expected, by hand from the published rates.
    const stt = (212.4 * 0.0077) / 60;
    const tts = (1840 * 0.03) / 1000;
    let llm = 0;
    for (let i = 0; i < 5; i++) llm += ((1800 + i - 1024) * 0.075 + 1024 * 0.075 + 120 * 0.3) / 1e6;
    llm += (1900 * 0.15 + 150 * 0.6) / 1e6;

    const cost = await sessionCost(db.pool, sessionId);
    const rows = await listUsage(db.pool, sessionId);
    const sumOfRows = rows.reduce((total, row) => total + row.costUsd, 0);
    expect(cost.costUsd.toFixed(6)).toBe(sumOfRows.toFixed(6));
    expect(cost.costUsd.toFixed(6)).toBe((stt + tts + llm).toFixed(6));
    expect(cost.costBreakdownUsd.stt.toFixed(6)).toBe(stt.toFixed(6));
    expect(cost.costBreakdownUsd.tts.toFixed(6)).toBe(tts.toFixed(6));
    expect(cost.costBreakdownUsd.llm.toFixed(6)).toBe(llm.toFixed(6));
    expect(cost.costBreakdownUsd.vision).toBe(0);
    expect(cost.actualSpendUsd).toBe(0); // free tiers (C1)
    // Every row carries its unit; request rows are free counters.
    expect(new Set(rows.map((r) => r.unit))).toEqual(new Set(["second", "character", "token", "request"]));
    expect(rows.filter((r) => r.unit === "request").every((r) => r.costUsd === 0)).toBe(true);
  });

  it("a session with no usage costs 0", async () => {
    expect(await sessionCost(db.pool, await seedSession(db.pool))).toEqual({ costUsd: 0, costBreakdownUsd: { stt: 0, llm: 0, tts: 0, vision: 0 }, actualSpendUsd: 0 });
  });

  it("refuses unpriced meters and impossible token counts instead of recording them at $0", async () => {
    const sessionId = await seedSession(db.pool);
    await expect(recordUsage(db.pool, { sessionId, provider: "groq", kind: "llama-x:input", units: 10 })).rejects.toBeInstanceOf(UnknownPriceError);
    await expect(recordLlmUsage(db.pool, { sessionId, provider: "groq", model: "openai/gpt-oss-20b", promptTokens: 10, completionTokens: 1, cachedTokens: 11 })).rejects.toThrow(
      RangeError,
    );
    await expect(recordLlmUsage(db.pool, { sessionId, provider: "groq", model: "openai/gpt-oss-20b", promptTokens: 1.5, completionTokens: 1 })).rejects.toThrow(RangeError);
    await expect(recordUsage(db.pool, { sessionId, provider: "deepgram", kind: "nova-3:audio", units: -1 })).rejects.toThrow(RangeError);
    expect(await listUsage(db.pool, sessionId)).toEqual([]);
  });
});

describe("rows of a meter no longer in the price table (a model retired after it was used)", () => {
  it("still count: the session cost and the daily counters read the stored unit and cost, never fail", async () => {
    const day = new Date("2032-05-06T12:00:00Z"); // a day no other test writes to
    const id = await seedSession(db.pool);
    await recordUsage(db.pool, { sessionId: id, provider: "deepgram", kind: "nova-3:audio", units: 60, at: day });
    // Priced when written (the rows carry their cost and unit); the price table no longer has these kinds.
    await insertUsage(db.pool, { sessionId: id, provider: "groq", kind: "retired-model:requests", units: 1, unit: "request", at: day });
    await insertUsage(db.pool, { sessionId: id, provider: "groq", kind: "retired-model:input", units: 1000, unit: "token", costUsd: 0.0001, at: day });
    await insertUsage(db.pool, { sessionId: id, provider: "deepgram", kind: "nova-2:audio", units: 120, unit: "second", costUsd: 0.0086, at: day });
    await insertUsage(db.pool, { sessionId: id, provider: "deepgram", kind: "aura-1:characters", units: 40, unit: "character", costUsd: 0.0006, at: day });
    expect(findPrice("groq", "retired-model:input")).toBeNull();

    const cost = await sessionCost(db.pool, id);
    expect(cost.costUsd).toBeCloseTo(0.0077 + 0.0001 + 0.0086 + 0.0006, 6);
    expect(cost.costBreakdownUsd.llm).toBeCloseTo(0.0001, 6);
    expect(cost.costBreakdownUsd.stt).toBeCloseTo(0.0077 + 0.0086, 6);
    expect(cost.costBreakdownUsd.tts).toBeCloseTo(0.0006, 6);
    expect(await dailyUsage(db.pool, day)).toMatchObject({ llmRequests: { "groq:retired-model": 1 }, audioMinutes: 3, ttsCharacters: 40 });
  });
});

describe("daily usage (quota guard input)", () => {
  it("counts the UTC day's LLM requests per model, audio minutes, TTS characters and upload bytes", async () => {
    const day = new Date("2031-03-04T12:00:00Z"); // a day no other test writes to
    const inDay = new Date("2031-03-04T00:00:00Z");
    const before = new Date("2031-03-03T23:59:59Z");
    const a = await seedSession(db.pool);
    const b = await seedSession(db.pool);
    await recordUsage(db.pool, { sessionId: a, provider: "deepgram", kind: "nova-3:audio", units: 90, at: inDay });
    await recordUsage(db.pool, { sessionId: b, provider: "deepgram", kind: "nova-3:audio", units: 30, at: day });
    await recordUsage(db.pool, { sessionId: a, provider: "deepgram", kind: "nova-3:audio", units: 600, at: before }); // the day before
    await recordUsage(db.pool, { sessionId: b, provider: "deepgram", kind: "aura-2:characters", units: 500, at: day });
    await recordLlmUsage(db.pool, { sessionId: a, provider: "groq", model: "openai/gpt-oss-20b", promptTokens: 10, completionTokens: 1, at: day });
    await recordLlmUsage(db.pool, { sessionId: b, provider: "groq", model: "openai/gpt-oss-20b", promptTokens: 10, completionTokens: 1, at: day });
    await recordLlmUsage(db.pool, { sessionId: b, provider: "gemini", model: "gemini-flash-lite-latest", promptTokens: 10, completionTokens: 1, at: day });
    await insertUsage(db.pool, { sessionId: a, provider: "groq", kind: "openai/gpt-oss-120b:requests", units: 1, unit: "request", at: before });
    await db.pool.query("INSERT INTO files (id, session_id, mime, size, sha256, created_at) VALUES ('fDay0000001', $1, 'application/pdf', 1000, $2, $3)", [a, "a".repeat(64), day]);
    await db.pool.query("INSERT INTO files (id, session_id, mime, size, sha256) VALUES ('fToday00001', $1, 'image/png', 7, $2)", [a, "b".repeat(64)]); // today, not 2031

    expect(await dailyUsage(db.pool, day)).toEqual({
      day: "2031-03-04",
      llmRequests: { "groq:openai/gpt-oss-20b": 2, "gemini:gemini-flash-lite-latest": 1 },
      audioMinutes: 2,
      ttsCharacters: 500,
      uploadBytes: 1000,
    });
  });
});
