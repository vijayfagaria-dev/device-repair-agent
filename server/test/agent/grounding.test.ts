// Live-call regressions: the model saved values the customer never said (urgency "critical" with an invented quote).
import { describe, expect, it } from "vitest";
import { groundingError } from "../../src/agent/grounding.js";
import { parseToolCall } from "../../src/agent/tools.js";

describe("groundingError", () => {
  const said = ["It's a phone.", "IPhone 14.", "Last week. Last Tuesday, I dropped it."];
  it("accepts the customer's own words", () => {
    expect(groundingError("It's a phone.", said)).toBeNull();
    expect(groundingError("last Tuesday", said)).toBeNull();
    expect(groundingError("IPhone 14", said)).toBeNull();
  });
  it("rejects an invented quote", () => {
    expect(groundingError("I need it back as soon as possible, it's critical for my work", said)).toMatch(/not said/);
  });
  it("rejects filler evidence and empty evidence", () => {
    expect(groundingError("...??", said)).toMatch(/exact words/);
    expect(groundingError("", said)).toMatch(/exact words/);
  });
  it("only counts recent utterances and nothing before the customer spoke", () => {
    expect(groundingError("It's a phone.", [])).not.toBeNull();
    const many = ["laptop", "a", "b", "c", "d"];
    expect(groundingError("laptop", many)).not.toBeNull();
  });
});

describe("save_field value", () => {
  it("rejects markup copied from the state message", () => {
    const r = parseToolCall("save_field", JSON.stringify({ field: "deviceModel", value: '<customer_words field="deviceModel">', spoken_evidence: "x" }));
    expect(r.ok).toBe(false);
  });
  it("accepts plain words", () => {
    expect(parseToolCall("save_field", JSON.stringify({ field: "deviceModel", value: "Apple iPhone 14", spoken_evidence: "IPhone 14" })).ok).toBe(true);
  });
});
