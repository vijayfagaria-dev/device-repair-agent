// Chat-field validators (P2-T03, D14): table tests; every rejection has a specific message.
import { describe, expect, it } from "vitest";
import {
  passesLuhn,
  validateAdditionalNotes,
  validateEmail,
  validateServiceCentre,
  validateSerialNumber,
  validateSubmitConfirmation,
} from "../../src/domain/validators/chatFields.js";

describe("passesLuhn", () => {
  it("accepts known-valid IMEIs and rejects a one-digit change", () => {
    for (const imei of ["490154203237518", "356938035643809", "352099001761481"]) expect(passesLuhn(imei), imei).toBe(true);
    for (const imei of ["490154203237519", "490154203237528", "356938035643808"]) expect(passesLuhn(imei), imei).toBe(false);
  });
});

describe("validateSerialNumber", () => {
  it.each([
    ["490154203237518", { kind: "imei", value: "490154203237518" }],
    ["35 209900 176148 1", { kind: "imei", value: "352099001761481" }],
    ["35-209900-176148-1", { kind: "imei", value: "352099001761481" }],
    ["３５２０９９００１７６１４８１", { kind: "imei", value: "352099001761481" }], // full-width digits (NFKC)
    ["c02xl0ghjg5h", { kind: "serial", value: "C02XL0GHJG5H" }],
    ["  R58N 1234 ABC ", { kind: "serial", value: "R58N1234ABC" }],
    ["ABCDEFGH", { kind: "serial", value: "ABCDEFGH" }],
    ["A1234567890123456789", { kind: "serial", value: "A1234567890123456789" }], // 20 characters
  ])("accepts %j", (input, normalized) => {
    expect(validateSerialNumber(input)).toEqual({ status: "valid", normalized });
  });

  it.each([
    ["35209900176148", "That IMEI has 14 digits; IMEIs have 15."],
    ["3520990017614811", "That IMEI has 16 digits; IMEIs have 15."],
    ["1", "That IMEI has 1 digit; IMEIs have 15."],
    ["490154203237519", "That IMEI's last digit doesn't match the others. Please check each digit."],
    ["000000000000000", "That doesn't look like a real IMEI. Please check it."],
    ["AAAAAAAA", "That doesn't look like a real serial number. Please check it."],
    ["ABC123", "That serial number has 6 characters; serial numbers have 8 to 20."],
    ["A12345678901234567890", "That serial number has 21 characters; serial numbers have 8 to 20."],
    ["ABC#12345", "Serial numbers use only letters and digits."],
    ["C02XL0GH/JG5H", "Serial numbers use only letters and digits."],
    ["", "Please type the serial number or IMEI."],
    ["   ", "Please type the serial number or IMEI."],
    [null, "Please type the serial number or IMEI."],
    [490154203237518, "Please type the serial number or IMEI."],
    ["9".repeat(65), "That's too long for a serial number or IMEI."],
  ])("rejects %j with a specific message", (input, error) => {
    expect(validateSerialNumber(input)).toEqual({ status: "invalid", error });
  });
});

describe("validateEmail", () => {
  it.each([
    ["asha.rao@example.com", "asha.rao@example.com"],
    ["  Asha.Rao@Example.COM ", "Asha.Rao@example.com"], // domain lowercased, local part kept
    ["asha+claims@example.co.in", "asha+claims@example.co.in"],
    ["o'brien@example.ie", "o'brien@example.ie"],
    ["user@xn--bcher-kva.de", "user@xn--bcher-kva.de"], // punycode domain
    ["user@bücher.de", "user@xn--bcher-kva.de"], // Unicode domain → punycode
    ["user@sub-domain.example.org", "user@sub-domain.example.org"],
    ["user@example.xn--p1ai", "user@example.xn--p1ai"],
  ])("accepts %j", (input, normalized) => {
    expect(validateEmail(input)).toEqual({ status: "valid", normalized });
  });

  it.each([
    ["a@b", "The part after the @ needs a domain like example.com."],
    ["foo@@x.com", "That email address has more than one @."],
    ["foo@bar@x.com", "That email address has more than one @."],
    ["foo.example.com", "That email address is missing the @."],
    ["@example.com", "Something is missing before the @."],
    ["asha rao@example.com", "Email addresses can't contain spaces."],
    ["asha@exa mple.com", "Email addresses can't contain spaces."],
    [".asha@example.com", "The part before the @ has characters an email address can't use."],
    ["asha..rao@example.com", "The part before the @ has characters an email address can't use."],
    ["asha<script>@example.com", "The part before the @ has characters an email address can't use."],
    ["asha@-example.com", "The part after the @ needs a domain like example.com."],
    ["asha@example..com", "The part after the @ needs a domain like example.com."],
    ["asha@example.c", "The part after the @ needs a domain like example.com."],
    ["asha@example.123", "The part after the @ needs a domain like example.com."],
    ["asha@example.com.", "The part after the @ needs a domain like example.com."],
    [`${"a".repeat(65)}@example.com`, "The part before the @ is too long."],
    [`a@${"b".repeat(250)}.com`, "That email address is too long."],
    // P2 audit: 225 characters typed, but 885 after punycode; the record used to cut it to 254.
    [`a@${Array.from({ length: 110 }, () => "ä").join(".")}.com`, "That email address is too long."],
    ["", "Please type your email address."],
    [42, "Please type your email address."],
  ])("rejects %j with a specific message", (input, error) => {
    expect(validateEmail(input)).toEqual({ status: "invalid", error });
  });
});

describe("validateServiceCentre", () => {
  it("accepts an id from the server's list", () => {
    expect(validateServiceCentre("blr-koramangala")).toEqual({
      status: "valid",
      normalized: { id: "blr-koramangala", name: "Koramangala Demo Repair Centre", city: "Bengaluru" },
    });
  });

  it("rejects a forged or unknown value from the chat card", () => {
    for (const value of ["blr-forged", "BLR-KORAMANGALA", "Koramangala", "", null, 3, ["blr-koramangala"]]) {
      expect(validateServiceCentre(value)).toEqual({ status: "invalid", error: "Please choose a service centre from the list." });
    }
  });

  it("matches a place heard on the call, and asks which one when a city has two", () => {
    expect(validateServiceCentre("the Koramangala one please", { spoken: true })).toMatchObject({ status: "valid", normalized: { id: "blr-koramangala" } });
    expect(validateServiceCentre("Karol Bagh", { spoken: true })).toMatchObject({ status: "valid", normalized: { id: "del-karol-bagh" } });
    expect(validateServiceCentre("somewhere in Mumbai", { spoken: true })).toEqual({
      status: "invalid",
      error: "There are 2 centres in Mumbai: Andheri or Dadar. Which one?",
    });
    expect(validateServiceCentre("Chennai", { spoken: true })).toEqual({
      status: "invalid",
      error: "I couldn't match that to one of our centres. I'll send you the list in the chat.",
    });
  });
});

describe("validateAdditionalNotes", () => {
  it("cleans text, keeping line breaks", () => {
    expect(validateAdditionalNotes("  Please call\u0007 before   visiting.\r\n\r\n\r\nGate code 12 ")).toEqual({
      status: "valid",
      normalized: "Please call before visiting.\n\nGate code 12",
    });
  });

  it("treats null, empty and whitespace as skipped", () => {
    for (const value of [null, undefined, "", "   \n "]) expect(validateAdditionalNotes(value)).toEqual({ status: "skipped" });
  });

  it("accepts exactly 1,000 characters and rejects more, counting emoji as one character each", () => {
    expect(validateAdditionalNotes("😀".repeat(1000)).status).toBe("valid");
    expect(validateAdditionalNotes("x".repeat(1001))).toEqual({ status: "invalid", error: "Notes can be up to 1,000 characters; this is 1,001." });
    expect(validateAdditionalNotes(12)).toEqual({ status: "invalid", error: "Please type your notes as text." });
  });

  it("strips invisible bidirectional and zero-width characters", () => {
    expect(validateAdditionalNotes("abc\u202Edef\u200Bghi")).toEqual({ status: "valid", normalized: "abcdefghi" });
  });
});

describe("validateSubmitConfirmation", () => {
  it("accepts only booleans", () => {
    expect(validateSubmitConfirmation(true)).toEqual({ status: "valid", normalized: true });
    expect(validateSubmitConfirmation(false)).toEqual({ status: "valid", normalized: false });
    for (const value of ["yes", 1, null]) expect(validateSubmitConfirmation(value)).toEqual({ status: "invalid", error: "Please tap Yes or No." });
  });
});
