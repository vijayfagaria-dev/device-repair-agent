// Field catalog invariants (P2-T01, D14).
import { CALL_FIELDS, CHAT_FIELDS, FIELD_IDS, OPTIONAL_FIELDS, RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { InputKind } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import { describeFieldsForPrompt, FIELDS, isFieldId, REQUIRED_RECORD_FIELDS } from "../../src/domain/fields.js";
import { findServiceCentre, SERVICE_CENTRES } from "../../src/domain/serviceCentres.js";

const all = Object.values(FIELDS);

describe("field catalog", () => {
  it("has 5 call fields, 4 chat fields, 2 optional fields and 1 confirmation field (the brief's minimums: ≥3, ≥3, ≥1)", () => {
    expect(all.filter((f) => f.primaryChannel === "call").map((f) => f.id)).toEqual([...CALL_FIELDS]);
    expect(all.filter((f) => f.primaryChannel === "chat" && f.required && f.id !== "submitConfirmation").map((f) => f.id)).toEqual([...CHAT_FIELDS]);
    expect(all.filter((f) => !f.required).map((f) => f.id)).toEqual([...OPTIONAL_FIELDS]);
    expect(all.filter((f) => f.card.kind === InputKind.CONFIRM).map((f) => f.id)).toEqual(["submitConfirmation"]);
    expect(Object.keys(FIELDS)).toEqual([...FIELD_IDS]);
    expect(RECORD_FIELD_IDS).toHaveLength(11);
    expect(REQUIRED_RECORD_FIELDS).toEqual([...CALL_FIELDS, ...CHAT_FIELDS]);
  });

  it("keys each definition by its own id", () => {
    for (const [key, field] of Object.entries(FIELDS)) expect(field.id).toBe(key);
  });

  it("gives every field a chat card, so a session can finish in chat after the call drops (PD5)", () => {
    for (const field of all) {
      expect(field.card.label, field.id).not.toBe("");
      expect(field.card.required, field.id).toBe(field.required);
    }
    // Voice fields get the fallback kinds named in D13.
    expect(FIELDS.deviceType.card.kind).toBe(InputKind.SELECT);
    expect(FIELDS.deviceModel.card.kind).toBe(InputKind.TEXT);
    expect(FIELDS.problemDescription.card.kind).toBe(InputKind.TEXT);
    expect(FIELDS.problemStartedAt.card.kind).toBe(InputKind.DATE);
    expect(FIELDS.urgency.card.kind).toBe(InputKind.SELECT);
  });

  it("makes exactly serialNumber and email chatOnly (identifiers must be typed, D13)", () => {
    expect(all.filter((f) => f.authority === "chatOnly").map((f) => f.id)).toEqual(["serialNumber", "email"]);
    for (const id of ["serialNumber", "email"] as const) expect(FIELDS[id].conflictClass).toBe("identifier");
  });

  it("never lets the call agent store files, notes or the confirmation (a spoken yes is not a confirmation, PD2)", () => {
    expect(all.filter((f) => !f.spokenCapture).map((f) => f.id)).toEqual(["purchaseInvoice", "additionalPhotos", "additionalNotes", "submitConfirmation"]);
    for (const field of all.filter((f) => !f.spokenCapture)) expect(field.conflictClass, field.id).toBe("chatInput");
  });

  it("uses the D15 conflict classes", () => {
    expect(Object.fromEntries(all.map((f) => [f.id, f.conflictClass]))).toMatchObject({
      deviceType: "choice",
      serviceCentre: "choice",
      problemDescription: "narrative",
      problemStartedAt: "narrative",
      urgency: "narrative",
      deviceModel: "typedPreferred",
    });
  });

  it("offers only server-listed service centres, and accepts only the four upload types (no HEIC, D10)", () => {
    expect(FIELDS.serviceCentre.card.options?.map((o) => o.value)).toEqual(SERVICE_CENTRES.map((c) => c.id));
    expect(FIELDS.purchaseInvoice.card.accept).toBe("application/pdf,image/jpeg,image/png,image/webp");
    expect(FIELDS.additionalPhotos.card).toMatchObject({ accept: "image/jpeg,image/png,image/webp", multiple: true });
    for (const field of all) if (field.card.accept) expect(field.card.accept, field.id).not.toMatch(/heic|heif/i);
  });

  it("has card patterns that compile (they are client hints only; the server always re-validates)", () => {
    for (const field of all) if (field.card.pattern) expect(() => new RegExp(field.card.pattern as string)).not.toThrow();
  });

  it("matches the approved card specs", () => {
    expect(Object.fromEntries(all.map((f) => [f.id, f.card]))).toMatchSnapshot();
  });

  it("isFieldId accepts only catalog ids", () => {
    expect(isFieldId("email")).toBe(true);
    for (const value of ["Email", "__proto__", "constructor", "", 1, null]) expect(isFieldId(value)).toBe(false);
  });
});

describe("service centres (PD8)", () => {
  it("is a small, clearly fictional list across Bengaluru, Mumbai and Delhi with unique ids", () => {
    expect(SERVICE_CENTRES).toHaveLength(6);
    expect(new Set(SERVICE_CENTRES.map((c) => c.id)).size).toBe(6);
    expect(new Set(SERVICE_CENTRES.map((c) => c.city))).toEqual(new Set(["Bengaluru", "Mumbai", "Delhi"]));
    for (const centre of SERVICE_CENTRES) expect(centre.name).toContain("Demo");
  });

  it("returns copies, so callers can't change the list", () => {
    const centre = findServiceCentre("mum-dadar");
    expect(centre).toEqual({ id: "mum-dadar", name: "Dadar Demo Repair Centre", city: "Mumbai" });
    if (centre) centre.name = "changed";
    expect(findServiceCentre("mum-dadar")?.name).toBe("Dadar Demo Repair Centre");
    expect(findServiceCentre("nope")).toBeNull();
    expect(Object.isFrozen(SERVICE_CENTRES)).toBe(true);
    for (const entry of SERVICE_CENTRES) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("freezes the whole catalog, cards and option lists included (shared by every session; P2 audit)", () => {
    const options = FIELDS.serviceCentre.card.options ?? [];
    expect(Object.isFrozen(FIELDS.serviceCentre.card)).toBe(true);
    expect(Object.isFrozen(options)).toBe(true);
    expect(() => (options as unknown[]).push({ value: "forged" })).toThrow(TypeError);
    expect(options.every((option) => Object.isFrozen(option))).toBe(true);
  });
});

describe("prompt description", () => {
  it("lists every field once, grouped by channel, deterministically", () => {
    const text = describeFieldsForPrompt();
    expect(text).toBe(describeFieldsForPrompt());
    for (const id of FIELD_IDS) expect(text.match(new RegExp(`^- ${id} \\(`, "gm")), id).toHaveLength(1);
    expect(text).toContain("- serialNumber (required): the IMEI or serial number; it must be typed");
    expect(text).toContain("- additionalNotes (optional)");
    expect(text.indexOf("Collect on the call")).toBeLessThan(text.indexOf("Collect in the chat"));
  });
});
