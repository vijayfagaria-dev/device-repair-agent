// The final-record card shows words, not the record's JSON (user report, 2026-11-11: "why such a raw experience").
import { describe, expect, it } from "vitest";
import { fieldLabel, formatField } from "../src/lib/record";

describe("formatField", () => {
  it.each([
    ["deviceType", "smartphone", "Smartphone"],
    ["deviceModel", { brand: "Apple", model: "iPhone 14" }, "Apple iPhone 14"],
    ["problemDescription", { summary: "Screen is cracked", verbatim: "Screen is cracked and touch has stopped working" }, "Screen is cracked"],
    ["problemStartedAt", { date: "2026-11-10", precision: "day", spoken: "Last Tuesday" }, "10 Nov 2026"],
    ["problemStartedAt", { date: "2026-11-02", precision: "week", spoken: "last week" }, "Week of 2 Nov 2026"],
    ["problemStartedAt", { date: "2026-10-01", precision: "month", spoken: "last month" }, "Oct 2026"],
    ["urgency", { level: "high", reason: "Quite urgent. I need it for work" }, "High: Quite urgent. I need it for work"],
    ["urgency", { level: "low" }, "Low"],
    ["serialNumber", { kind: "imei", value: "352099001761481" }, "IMEI 352099001761481"],
    ["serialNumber", { kind: "serial", value: "C02XL0ABJGH5" }, "Serial C02XL0ABJGH5"],
    ["serviceCentre", { id: "mum-dadar", name: "Dadar Demo Repair Centre", city: "Mumbai" }, "Dadar Demo Repair Centre, Mumbai"],
    ["email", "test1@example.com", "test1@example.com"],
    ["additionalNotes", null, "—"],
    ["additionalPhotos", [], "—"],
  ])("%s", (name, value, shown) => expect(formatField(name, value)).toBe(shown));

  it("shows a file as its type and size and never the signed link", () => {
    const shown = formatField("purchaseInvoice", { fileId: "f1", mime: "image/png", size: 78744, sha256: "ab", url: "https://x/files/f1?exp=1&sig=SECRET" });
    expect(shown).toBe("PNG, 79 KB");
    expect(shown).not.toMatch(/sig|https|SECRET/);
  });
  it("labels fields the way the claim summary does", () => {
    expect(fieldLabel("problemStartedAt")).toBe("Started");
    expect(fieldLabel("somethingElse")).toBe("something else");
  });
  it("an unknown object still shows, rather than nothing", () => {
    expect(formatField("mystery", { a: 1 })).toBe('{"a":1}');
  });
});
