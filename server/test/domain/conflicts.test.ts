// Conflict resolution (P2-T05, D15): class × {same, different, one invalid, both invalid, same-source correction,
// latest wins, chatOnly spoken-only}.
import { describe, expect, it } from "vitest";
import { type Candidate, resolveField, sameValue } from "../../src/domain/conflicts.js";
import { candidate, FILE, valid } from "./helpers.js";

const IMEI_A = { kind: "imei", value: "352099001761481" };
const IMEI_B = { kind: "imei", value: "490154203237518" };

/** Every permutation of the history must give the same result. */
function resolveAllOrders(field: Parameters<typeof resolveField>[0], history: Candidate[]) {
  const results = new Set<string>();
  const permute = (items: Candidate[], prefix: Candidate[] = []) => {
    if (items.length === 0) results.add(JSON.stringify(resolveField(field, prefix)));
    for (const [i, item] of items.entries()) permute([...items.slice(0, i), ...items.slice(i + 1)], [...prefix, item]);
  };
  permute(history);
  expect(results.size, "result depends on input order").toBe(1);
  return resolveField(field, history);
}

describe("no candidates, one source, invalid and skipped", () => {
  it("is missing with no history", () => {
    expect(resolveField("deviceType", [])).toEqual({ value: null, source: null, collectedAt: null, status: "missing", conflict: null });
  });

  it("uses a single valid value as is", () => {
    const c = valid("call", "laptop");
    expect(resolveField("deviceType", [c])).toEqual({ value: "laptop", source: "call", collectedAt: c.collectedAt, status: "valid", conflict: null });
  });

  it("is invalid (with no value) when every candidate is invalid, recording where and when", () => {
    const first = candidate("chat", "invalid", null);
    const c = candidate("chat", "invalid", null);
    expect(resolveField("email", [c, first])).toEqual({ value: null, source: "chat", collectedAt: c.collectedAt, status: "invalid", conflict: null });
  });

  it("keeps the latest valid value when a later answer from the same source is invalid", () => {
    const good = valid("call", { brand: "Apple", model: "iPhone 14" });
    expect(resolveAllOrders("deviceModel", [good, candidate("call", "invalid", null)])).toMatchObject({ status: "valid", value: good.normalized });
  });

  it("lets a correction from the same source replace the earlier value (latest valid wins; nothing is overwritten)", () => {
    const first = valid("chat", "asha@example.com");
    const correction = valid("chat", "asha.rao@example.com");
    expect(resolveAllOrders("email", [first, correction])).toMatchObject({ status: "valid", value: "asha.rao@example.com", conflict: null });
  });

  it("reports an explicitly skipped optional field as skipped", () => {
    expect(resolveField("additionalNotes", [candidate("chat", "skipped", null)])).toMatchObject({ status: "skipped", value: null, source: "chat" });
    expect(resolveField("additionalNotes", [candidate("chat", "skipped", null), valid("chat", "gate code 12")])).toMatchObject({ status: "valid", value: "gate code 12" });
  });

  it("orders by commit order (seq) even when clocks disagree, and breaks seq ties deterministically", () => {
    const later = valid("chat", "a@example.com", { seq: 10, collectedAt: "2026-11-07T04:30:00.000Z" });
    const earlier = valid("chat", "b@example.com", { seq: 9, collectedAt: "2026-11-07T05:00:00.000Z" });
    expect(resolveAllOrders("email", [later, earlier]).value).toBe("a@example.com");
    const tieA = valid("chat", "a@example.com", { seq: 20, collectedAt: "2026-11-07T04:30:00.000Z" });
    const tieB = valid("chat", "b@example.com", { seq: 20, collectedAt: "2026-11-07T04:30:00.000Z" });
    resolveAllOrders("email", [tieA, tieB]);
  });
});

describe("identifier class (serialNumber, email): chatOnly, typed always wins", () => {
  it("a spoken-only identifier is unverified, never valid, even if the model marked it valid", () => {
    for (const status of ["valid", "unverified"] as const) {
      const heard = candidate("call", status, "asha@example.com");
      expect(resolveField("email", [heard])).toEqual({ value: "asha@example.com", source: "call", collectedAt: heard.collectedAt, status: "unverified", conflict: null });
    }
  });

  it("equal typed and spoken values are corroboration", () => {
    const result = resolveAllOrders("email", [valid("chat", "Asha@example.com"), candidate("call", "unverified", "asha@example.com")]);
    expect(result).toMatchObject({ status: "valid", source: "chat", value: "Asha@example.com" });
    expect(result.conflict).toMatchObject({ resolution: "same", reason: "values equal after normalization", unresolved: false });
  });

  it("different values: the typed one wins", () => {
    const result = resolveAllOrders("serialNumber", [candidate("call", "unverified", IMEI_B), valid("chat", IMEI_A)]);
    expect(result).toMatchObject({ status: "valid", source: "chat", value: IMEI_A });
    expect(result.conflict).toEqual({
      field: "serialNumber",
      callValue: IMEI_B,
      chatValue: IMEI_A,
      resolution: "chatValue",
      reason: "typed value preferred over spoken for identifiers",
      unresolved: false,
    });
  });

  it("escalates when the user had confirmed the spoken value, until they confirm the typed one", () => {
    const confirmedSpoken = candidate("call", "unverified", IMEI_B, { userConfirmed: true });
    const typed = valid("chat", IMEI_A);
    expect(resolveField("serialNumber", [confirmedSpoken, typed]).conflict).toMatchObject({ resolution: "chatValue", unresolved: true });
    // The user picks on the "which is correct?" card: a user-confirmed chat candidate (protocol.md §5).
    const picked = valid("chat", IMEI_B, { userConfirmed: true });
    expect(resolveAllOrders("serialNumber", [confirmedSpoken, typed, picked])).toMatchObject({ value: IMEI_B, conflict: { resolution: "same", unresolved: false } });
  });

  it("ignores an invalid typed value: the field stays unverified until a valid one is typed", () => {
    expect(resolveField("email", [candidate("call", "unverified", "a@example.com"), candidate("chat", "invalid", null)])).toMatchObject({ status: "unverified" });
  });
});

describe("choice class (deviceType, serviceCentre): most recent explicit choice", () => {
  it("different values: the later one wins, whichever channel", () => {
    const callFirst = resolveAllOrders("deviceType", [valid("call", "tablet"), valid("chat", "laptop")]);
    expect(callFirst).toMatchObject({ value: "laptop", source: "chat", conflict: { resolution: "chatValue", reason: "most recent explicit choice" } });
    const chatFirst = resolveAllOrders("deviceType", [valid("chat", "laptop"), valid("call", "tablet")]);
    expect(chatFirst).toMatchObject({ value: "tablet", source: "call", conflict: { resolution: "callValue" } });
  });

  it("same value is corroboration; one side invalid means no conflict", () => {
    const centre = { id: "mum-dadar", name: "Dadar Demo Repair Centre", city: "Mumbai" };
    expect(resolveAllOrders("serviceCentre", [valid("call", centre), valid("chat", { ...centre, name: "renamed" })]).conflict?.resolution).toBe("same");
    expect(resolveAllOrders("serviceCentre", [valid("call", centre), candidate("chat", "invalid", null)])).toMatchObject({ value: centre, source: "call", conflict: null });
  });
});

describe("narrative class (problemDescription, problemStartedAt, urgency): spoken preferred, typed kept as addendum", () => {
  it("different values: the spoken account wins even when the typed one is later", () => {
    const spoken = valid("call", { level: "high", reason: "work" });
    const typed = valid("chat", { level: "normal", reason: null });
    const result = resolveAllOrders("urgency", [spoken, typed]);
    expect(result).toMatchObject({ value: spoken.normalized, source: "call" });
    expect(result.conflict).toMatchObject({ resolution: "callValue", chatValue: typed.normalized, reason: "spoken account preferred; typed version kept as an addendum" });
  });

  it("same date at different precision of wording is still the same", () => {
    expect(
      resolveAllOrders("problemStartedAt", [valid("call", { date: "2026-11-03", precision: "day", spoken: "last Tuesday" }), valid("chat", { date: "2026-11-03", precision: "day", spoken: null })])
        .conflict?.resolution,
    ).toBe("same");
  });

  it("both invalid is invalid", () => {
    expect(resolveField("problemDescription", [candidate("call", "invalid", null), candidate("chat", "invalid", null)]).status).toBe("invalid");
  });
});

describe("typedPreferred class (deviceModel): typed wins for spelling", () => {
  it("different values: the typed model wins", () => {
    const result = resolveAllOrders("deviceModel", [valid("chat", { brand: "Samsung", model: "Galaxy S23" }), valid("call", { brand: "Samsung", model: "Galaxy S 23" })]);
    expect(result).toMatchObject({ source: "chat", conflict: { resolution: "chatValue", reason: "typed value preferred for spelling" } });
  });

  it("compares case-insensitively", () => {
    expect(sameValue("deviceModel", { brand: "Apple", model: "iPhone 14" }, { brand: "apple", model: "IPHONE 14" })).toBe(true);
  });
});

describe("chatInput class (files, notes): call candidates are ignored", () => {
  it("never takes a value from the call", () => {
    expect(resolveField("purchaseInvoice", [valid("call", FILE)])).toMatchObject({ status: "missing" });
    expect(resolveAllOrders("purchaseInvoice", [valid("call", { ...FILE, fileId: "other" }), valid("chat", FILE)])).toMatchObject({ value: FILE, conflict: null });
  });
});
