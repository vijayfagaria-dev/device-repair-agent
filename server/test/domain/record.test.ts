// The record builder and JSON Schema (P2-T07): golden records for the 4 outcomes, a 1,000-case fuzz test through the
// real validators, content-hash properties, and the typed schema error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecordFieldId } from "@device-repair/shared/fields";
import type { FinalRecord } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "../../src/domain/canonicalJson.js";
import { buildRecord, type ClaimRecord, contentHash, type RecordInput, RecordSchemaError, validateRecord } from "../../src/domain/record.js";
import { randomRecordInput } from "./fuzz.js";
import { prng } from "./helpers.js";
import { SCENARIOS, SIGNER } from "./scenarios.js";

const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

describe("golden records (the 4 outcomes)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name} matches golden/${name}.json and validates`, () => {
      const { record, contentHash: hash } = buildRecord(scenario());
      expect(record.outcome).toBe(name);
      const file = `${GOLDEN_DIR}${name}.json`;
      const actual = `${JSON.stringify({ contentHash: hash, record }, null, 2)}\n`;
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, actual);
      }
      expect(existsSync(file), `missing ${file}; run with UPDATE_GOLDEN=1 and review the output`).toBe(true);
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }

  it("the golden content is what the scenarios intend", () => {
    const completed = buildRecord(SCENARIOS.completed()).record;
    expect(completed.missingRequired).toEqual([]);
    expect(completed.submitConfirmation).toEqual({ confirmed: true, source: "chat", at: "2026-11-10T10:16:30+05:30" });
    expect(completed.conflicts).toEqual([
      { field: "email", callValue: "asha.rao@example.com", chatValue: "Asha.Rao@example.com", resolution: "same", reason: "values equal after normalization" },
    ]);
    expect(completed.fields.serialNumber).toMatchObject({ status: "valid", value: { kind: "imei", value: "352099001761481" } });
    expect(completed.fields.purchaseInvoice.value).toMatchObject({ fileId: "fInvoice7Kq2Lm9x", url: SIGNER("fInvoice7Kq2Lm9x") });
    expect(completed.fields.additionalPhotos).toMatchObject({ status: "skipped", value: null });
    expect(completed.previousRevision).toEqual({ revision: 1, outcome: "partial" });

    const partial = buildRecord(SCENARIOS.partial()).record;
    expect(partial.missingRequired).toEqual(["purchaseInvoice", "email"]);
    expect(partial.fields.email).toMatchObject({ status: "unverified", source: "call", value: "asha.rao@example.com" });
    expect(partial.outcomeReason).toBe("idle timeout with required fields missing: purchaseInvoice, email (unverified)");

    const needsReview = buildRecord(SCENARIOS.needsReview()).record;
    expect(needsReview.reviewFlags.map((f) => f.rule)).toEqual(["R-1", "R-2"]);
    expect(needsReview.conflicts.map((c) => [c.field, c.resolution])).toEqual([["urgency", "callValue"], ["serialNumber", "chatValue"]]);

    const optedOut = buildRecord(SCENARIOS.optedOut()).record;
    expect(optedOut.fields.problemDescription).toMatchObject({ status: "invalid", value: null, source: "call" });
  });

  it("is a FinalRecord, so the starter UI can render it", () => {
    const wire: FinalRecord = buildRecord(SCENARIOS.completed()).record;
    expect(wire.fields.deviceType?.status).toBe("valid");
  });
});

describe("content hash (D17)", () => {
  const base = SCENARIOS.completed;
  const hashOf = (input: RecordInput) => buildRecord(input).contentHash;

  it("is a SHA-256 hex digest, stable across builds", () => {
    expect(hashOf(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(base())).toBe(hashOf(base()));
  });

  it("doesn't change with engagement, cost, build or end time, or freshly signed file URLs", () => {
    const original = hashOf(base());
    expect(hashOf({ ...base(), engagement: { calls: 3, callSeconds: 999, chatMessages: 40, chatInputsSubmitted: 12, invalidAttempts: 7 } })).toBe(original);
    expect(hashOf({ ...base(), cost: { costUsd: 9, costBreakdownUsd: { stt: 1, llm: 2, tts: 3, vision: 3 }, actualSpendUsd: 0 } })).toBe(original);
    expect(hashOf({ ...base(), now: new Date("2027-01-01T00:00:00Z"), endedAt: new Date("2027-01-01T00:00:00Z") })).toBe(original);
    expect(hashOf({ ...base(), signFileUrl: (id) => `https://repair.example.com/files/${id}?exp=1999999999&sig=OTHER` })).toBe(original);
    expect(hashOf({ ...base(), revision: 7, previousRevision: { revision: 6, outcome: base().outcome } })).toBe(original);
  });

  it("changes when the claim changes: a field, the outcome reason, the flags or the confirmation", () => {
    const original = hashOf(base());
    const input = base();
    expect(hashOf({ ...input, fields: { ...input.fields, email: { ...input.fields.email, value: "other@example.com" } } })).not.toBe(original);
    expect(hashOf({ ...input, outcomeReason: "different" })).not.toBe(original);
    expect(hashOf({ ...input, reviewFlags: [{ rule: "R-5", reason: "agent" }], outcome: "needsReview" as never })).not.toBe(original);
    expect(hashOf({ ...input, submitConfirmedAt: "2026-11-10T04:46:31Z" })).not.toBe(original);
  });

  it("is unchanged by key order in the input values", () => {
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
      return value;
    };
    const input = base();
    const reordered: RecordInput = { ...input, fields: reverseKeys(input.fields) as RecordInput["fields"] };
    expect(hashOf(reordered)).toBe(hashOf(input));
    expect(JSON.stringify(buildRecord(reordered).record)).toBe(JSON.stringify(buildRecord(input).record));
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("refuses values JSON can't represent faithfully", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, new Date(), () => 1, 1n]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });
});

describe("schema failures", () => {
  it("throws a typed error naming the paths, never the values", () => {
    const { record } = buildRecord(SCENARIOS.completed());
    const broken = structuredClone(record) as unknown as Record<string, unknown>;
    (broken.fields as Record<string, unknown>).email = { value: "secret-value@example.com", source: "chat", collectedAt: null, status: "valid" };
    broken.extra = "secret-extra";
    let error: unknown;
    try {
      validateRecord(broken);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RecordSchemaError);
    const problems = (error as RecordSchemaError).problems;
    expect(problems.some((p) => p.path === "/fields/email/collectedAt")).toBe(true);
    expect(problems.some((p) => p.keyword === "additionalProperties")).toBe(true);
    expect((error as Error).message).not.toContain("secret");
  });

  it("buildRecord refuses a value the schema doesn't allow (e.g. a completed record with a missing field)", () => {
    const input = SCENARIOS.completed();
    expect(() => buildRecord({ ...input, missingRequired: ["email"] })).toThrow(RecordSchemaError);
    expect(() => buildRecord({ ...input, sessionId: "not-a-uuid" })).toThrow(RecordSchemaError);
  });

  it("strips anything the schema doesn't name from values (evidence, raw input, paths)", () => {
    const input = SCENARIOS.completed();
    const sneaky = { ...input.fields.deviceModel, value: { brand: "Apple", model: "iPhone 14 Pro", evidence: "transcript...", path: "/tmp/x" } };
    const { record } = buildRecord({ ...input, fields: { ...input.fields, deviceModel: sneaky } });
    expect(record.fields.deviceModel.value).toEqual({ brand: "Apple", model: "iPhone 14 Pro" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fuzz: random answers through the real validators, resolver and outcome machine; every record must validate.

describe("fuzz: 1,000 random candidate sets", () => {
  it("every finalized record validates against the schema, and validators never throw", () => {
    const random = prng(7_2026_11_10);
    const outcomes = new Map<string, number>();
    let built = 0;
    for (let i = 0; i < 1000; i++) {
      const { record, contentHash: hash } = buildRecord(randomRecordInput(random)); // throws RecordSchemaError on any invalid record
      expect(hash).toBe(contentHash(record));
      built += 1;
      outcomes.set(record.outcome, (outcomes.get(record.outcome) ?? 0) + 1);
    }
    expect(built).toBe(1000);
    expect([...outcomes.keys()].sort()).toEqual(["completed", "needsReview", "optedOut", "partial"]);
  }, 60_000); // see recordSanitization.test.ts: slow only under coverage with every file in parallel
});

// Type-level: the record's field keys are exactly the catalog's record fields.
const _keys: Record<RecordFieldId, unknown> = {} as ClaimRecord["fields"];
void _keys;
