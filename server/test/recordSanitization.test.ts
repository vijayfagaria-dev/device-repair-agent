// The sanitization oracle (P6-T02) on every record the system can produce: the four golden records, 1,000 fuzz
// records, hostile input pushed through the builder, plus the oracle's own tests (it must catch what it claims to).
// Scenario records produced through the real handlers and the DTO checks live beside their suites
// (session/finalize.test.ts, scenarios/chatOnly.test.ts, http/sessionsRead.test.ts) and call the same oracle.
import { Outcome } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import { buildRecord, type ClaimRecord, type RecordInput } from "../src/domain/record.js";
import { randomRecordInput } from "./domain/fuzz.js";
import { allValid, prng, resolved, VALID_VALUES } from "./domain/helpers.js";
import { SCENARIOS, SIGNER } from "./domain/scenarios.js";
import { expectNoLeaks, expectSanitizedRecord, leakViolations, recordViolations } from "./helpers/recordOracle.js";

// 1,000 records through the real validators take ~1 s alone, several times that under coverage with every file in parallel.
const FUZZ_TIMEOUT_MS = 60_000;
const SECRETS = ["sk-live-0123456789abcdef", "gsk_0123456789abcdefghij", "postgresql://user:pw@host/db"];

describe("the oracle accepts what the system produces", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`golden ${name} record`, () => {
      expectSanitizedRecord(buildRecord(scenario()).record, { secrets: SECRETS });
    });
  }

  it("1,000 fuzz records", () => {
    const random = prng(7_2026_11_10);
    for (let i = 0; i < 1000; i++) {
      const { record } = buildRecord(randomRecordInput(random));
      const found = recordViolations(record, { secrets: SECRETS });
      expect(found, `fuzz record ${i}`).toEqual([]);
    }
  }, FUZZ_TIMEOUT_MS);

  it("hostile input is neutralised by the builder, not just rejected by the oracle", () => {
    const hostile = "a\u0000b\u202Ec\u200B  d\u{E0041}\u0007e";
    const input: RecordInput = {
      ...SCENARIOS.completed(),
      fields: allValid({
        problemDescription: resolved("valid", { summary: hostile, verbatim: `${hostile}\r\n${"x".repeat(2000)}`, evidence: "/data/uploads/secret.pdf", raw: "file:abc" }, "call"),
        deviceModel: resolved("valid", { brand: hostile, model: "e\u0301".repeat(200), storageKey: "/data/x" }, "call"),
        additionalNotes: resolved("valid", `line one\u0000\n\n\n\n  line   two\u202E\n${"y".repeat(1500)}`, "chat"),
        purchaseInvoice: resolved("valid", { ...(VALID_VALUES.purchaseInvoice as object), path: "/data/uploads/f1.pdf", url: "file:fInvoice000001" }, "chat"),
      }),
    };
    const { record } = buildRecord(input);
    expectSanitizedRecord(record, { secrets: SECRETS });
    expect(JSON.stringify(record)).not.toMatch(/\/data\/|file:|evidence|storageKey/);
    expect(record.fields.problemDescription.value).toMatchObject({ summary: "abc de" });
    expect(record.fields.additionalNotes.value).toMatch(/^line one\n\nline two\n/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The oracle itself: each class of forbidden content, planted into a valid record, is found, at the right path.

const clone = <T>(value: T): T => structuredClone(value);
const base = (): ClaimRecord => clone(buildRecord(SCENARIOS.completed()).record);

/** Plants a change, returns the rules the oracle reports (paths are checked where they matter). */
function planted(change: (record: ClaimRecord) => void, secrets: readonly string[] = SECRETS): { path: string; rule: string }[] {
  const record = base();
  change(record);
  return recordViolations(record, { secrets });
}

describe("the oracle catches", () => {
  it("a clean record is clean (so the cases below really come from the planted change)", () => {
    expect(recordViolations(base(), { secrets: SECRETS })).toEqual([]);
  });

  it.each([
    ["an internal /data/ path", (r: ClaimRecord) => ((r.fields.email.value as unknown) = "/data/uploads/f1.pdf"), "fields.email.value", "internal path /data/"],
    ["a file: ref in a file value", (r: ClaimRecord) => ((r.fields.purchaseInvoice.value as { url: string }).url = "file:fInvoice7Kq2Lm9x"), "fields.purchaseInvoice.value.url", "file link is not a signed /files/ link"],
    ["a file: ref in a structural string", (r: ClaimRecord) => (r.outcomeReason = "see file:fInvoice7Kq2Lm9x"), "outcomeReason", "internal file ref (file:)"],
    ["an sk- key", (r: ClaimRecord) => (r.outcomeReason = "key sk-abcd1234efgh"), "outcomeReason", "api key (sk-)"],
    ["a gsk_ key", (r: ClaimRecord) => (r.fields.serviceCentre.value as { name: string }).name = "gsk_abcdefghijkl", "fields.serviceCentre.value.name", "api key (gsk_)"],
    ["a provider request id", (r: ClaimRecord) => (r.outcomeReason = "failed req_01abcdefgh23"), "outcomeReason", "provider request id"],
    ["a chat completion id", (r: ClaimRecord) => (r.outcomeReason = "chatcmpl-abc12345"), "outcomeReason", "provider request id"],
    ["a database url", (r: ClaimRecord) => (r.outcomeReason = "postgres://u:p@h/db"), "outcomeReason", "database url"],
    ["a bearer token", (r: ClaimRecord) => (r.outcomeReason = "Authorization Bearer abcdef123456"), "outcomeReason", "bearer token"],
    ["a control character", (r: ClaimRecord) => ((r.fields.email.value as unknown) = "a\u0007@example.com"), "fields.email.value", "control or invisible character"],
    ["a zero-width character", (r: ClaimRecord) => (r.outcomeReason = "all\u200B good"), "outcomeReason", "control or invisible character"],
    ["a bidi override", (r: ClaimRecord) => ((r.fields.deviceType.value as unknown) = "phone\u202E"), "fields.deviceType.value", "control or invisible character"],
    ["a tag character (hidden text)", (r: ClaimRecord) => (r.outcomeReason = "ok\u{E0041}"), "outcomeReason", "control or invisible character"],
    ["a newline in a one-line field", (r: ClaimRecord) => ((r.fields.deviceType.value as unknown) = "phone\nlaptop"), "fields.deviceType.value", "control or invisible character"],
    ["text that isn't NFC", (r: ClaimRecord) => ((r.fields.deviceType.value as unknown) = "e\u0301"), "fields.deviceType.value", "not NFC"],
    ["uncollapsed whitespace", (r: ClaimRecord) => (r.outcomeReason = " padded  reason "), "outcomeReason", "uncollapsed whitespace"],
    ["an over-long email", (r: ClaimRecord) => ((r.fields.email.value as unknown) = `${"a".repeat(300)}@example.com`), "fields.email.value", "longer than 254"],
    ["an over-long summary", (r: ClaimRecord) => ((r.fields.problemDescription.value as { summary: string }).summary = "s".repeat(301)), "fields.problemDescription.value.summary", "longer than 300"],
    ["an over-long outcome reason", (r: ClaimRecord) => (r.outcomeReason = "r".repeat(1001)), "outcomeReason", "longer than 1000"],
    ["an unsigned file link", (r: ClaimRecord) => ((r.fields.purchaseInvoice.value as { url: string }).url = "https://example.com/uploads/invoice.pdf"), "fields.purchaseInvoice.value.url", "file link is not a signed /files/ link"],
    ["a configured secret in a structural field", (r: ClaimRecord) => (r.outcomeReason = `leaked ${SECRETS[0]}`), "outcomeReason", "configured secret"],
    ["a hidden key", (r: ClaimRecord) => ((r as unknown as Record<string, unknown>).storageKey = "x"), "storageKey", "hidden key"],
    ["a non-IST timestamp", (r: ClaimRecord) => (r.endedAt = "2026-11-10T04:46:40Z"), "endedAt", "timestamp is not IST ISO-8601"],
    ["a valid field with no value", (r: ClaimRecord) => ((r.fields.email as { value: unknown }).value = null), "fields.email", "valid or unverified field without a value"],
    ["a value without a source", (r: ClaimRecord) => ((r.fields.email as { source: unknown }).source = null), "fields.email", "value without a source"],
    ["an unknown field", (r: ClaimRecord) => ((r.fields as unknown as Record<string, unknown>).passport = {}), "fields.passport", "unknown field"],
  ])("%s", (_name, change, path, rule) => {
    expect(planted(change)).toContainEqual({ path, rule });
  });

  it("a conflict's values are held to the same caps as the field they belong to", () => {
    const record = buildRecord(SCENARIOS.needsReview()).record;
    const urgency = record.conflicts.find((c) => c.field === "urgency");
    expect(urgency).toBeDefined();
    (urgency as { callValue: unknown }).callValue = { level: "high", reason: "x".repeat(201) };
    const index = record.conflicts.findIndex((c) => c.field === "urgency");
    expect(recordViolations(record)).toContainEqual({ path: `conflicts[${index}].callValue.reason`, rule: "longer than 200" });
  });

  it("a configured secret is found even inside free text; leak patterns are not applied to what the user wrote", () => {
    const withSecret = planted((r) => ((r.fields.additionalNotes.value as unknown) = `my key is ${SECRETS[1]}`));
    expect(withSecret).toContainEqual({ path: "fields.additionalNotes.value", rule: "configured secret" });
    const withText = planted((r) => ((r.fields.additionalNotes.value as unknown) = "I saved it under file: invoice and in /data/ on my phone, model SK-1200"));
    expect(withText).toEqual([]);
  });

  it("an outcome reason is strict except on needsReview, where it quotes the flags' free text", () => {
    expect(planted((r) => (r.outcomeReason = "all good, see file:fAbc12345"))).toContainEqual({ path: "outcomeReason", rule: "internal file ref (file:)" });
    expect(planted((r) => { r.outcome = Outcome.NEEDS_REVIEW; r.outcomeReason = "needs review: R-1 safety: battery at /data/x"; })).toEqual([]);
  });

  it("real file ids (base64url, so with - and _) are not mistaken for links or keys", () => {
    // newFileId() = "f" + 16 base64url characters; these hold "-sk-", "_dg_" and "-AIza" inside, and signed links to them.
    for (const fileId of ["fAb-sk-1234abcdEFg", "fXy_dg_123456AbCd", "fQ-AIzaSyabcdef12", "f--__--__--__--__"]) {
      const record = base();
      const files = record.fields.purchaseInvoice.value as { fileId: string; url: string };
      files.fileId = fileId;
      files.url = SIGNER(fileId);
      expect(recordViolations(record), fileId).toEqual([]);
    }
  });

  it("a violation never repeats the offending value", () => {
    const found = planted((r) => (r.outcomeReason = "key sk-abcd1234efgh"));
    expect(JSON.stringify(found)).not.toContain("abcd1234efgh");
    expect(() => expectSanitizedRecord({ ...base(), outcomeReason: "key sk-abcd1234efgh" })).toThrow(/outcomeReason: api key \(sk-\)/);
    try {
      expectSanitizedRecord({ ...base(), outcomeReason: "key sk-abcd1234efgh" });
    } catch (err) {
      expect(String(err)).not.toContain("abcd1234efgh");
    }
  });
});

describe("the leak scan (for API responses)", () => {
  it("finds internal paths, file refs, provider ids, credentials, hidden keys and signed links anywhere", () => {
    const body = {
      sessionId: "s",
      events: [{ payload: { note: "stored at /tmp/a/b", ref: "file:fAbc12345", requestId: "chatcmpl-9f8e7d6c", providerCallId: "x", apiKey: "k" } }],
      files: [{ url: SIGNER("fInvoice7Kq2Lm9x") }],
    };
    const rules = leakViolations(body, { secrets: SECRETS }).map((v) => `${v.path}: ${v.rule}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "events[0].payload.note: internal path",
        "events[0].payload.ref: internal file ref (file:)",
        "events[0].payload.requestId: provider request id",
        "events[0].payload.providerCallId: hidden key",
        "events[0].payload.apiKey: hidden key",
        "files[0].url: signed link outside a record",
        "files[0].url: url key outside a record",
      ]),
    );
  });

  it("allows the signed links a record carries, and nothing else changes", () => {
    const record = base();
    expect(leakViolations(record, {}, true)).toEqual([]);
    expect(leakViolations(record, {}, false).length).toBeGreaterThan(0);
    expect(() => expectNoLeaks(record, { secrets: SECRETS }, true)).not.toThrow();
  });

  it("passes counts and ordinary words that merely look like keys", () => {
    expect(leakViolations({ promptTokens: 812, completionTokens: 40, text: "my task is to ask about it", note: "disk-space low" })).toEqual([]);
  });
});
