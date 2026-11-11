// File validation (P2-T04, D10): magic bytes decide the type; size, count and declared-vs-real mismatches are rejected.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeDeclaredType,
  parseFileRef,
  sanitizeFileName,
  sniffFileType,
  validateFileSelection,
  validateUpload,
} from "../../src/domain/validators/files.js";

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));

const PDF = bytes("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF\u0000", [0x01, 0x01, 0x00], [0xff, 0xd9]);
const WEBP = bytes("RIFF", [0x1a, 0, 0, 0], "WEBPVP8 ", [0x0e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const HEIC = bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic");
const TEXT = bytes("Invoice #123\nTotal: 999\n");

describe("sniffFileType", () => {
  it("recognises the four accepted types and HEIC by their first bytes", () => {
    expect(sniffFileType(PDF)).toBe("application/pdf");
    expect(sniffFileType(PNG)).toBe("image/png");
    expect(sniffFileType(JPEG)).toBe("image/jpeg");
    expect(sniffFileType(WEBP)).toBe("image/webp");
    expect(sniffFileType(HEIC)).toBe("image/heic");
  });

  it("returns null for anything else, including truncated signatures", () => {
    for (const sample of [TEXT, bytes("MZ\u0090\u0000"), bytes("%PD"), bytes("RIFF1234WAVE"), bytes([0x89, 0x50, 0x4e]), Buffer.alloc(0)]) {
      expect(sniffFileType(sample)).toBeNull();
    }
  });
});

describe("validateUpload", () => {
  it("accepts a tiny PDF and PNG, returning size, SHA-256 and a safe name", () => {
    expect(validateUpload("purchaseInvoice", { bytes: PDF, declaredType: "application/pdf", name: "invoice.pdf" })).toEqual({
      status: "valid",
      normalized: { mime: "application/pdf", size: PDF.length, sha256: createHash("sha256").update(PDF).digest("hex"), originalName: "invoice.pdf" },
    });
    expect(validateUpload("additionalPhotos", { bytes: PNG, declaredType: "image/png", name: "damage.png" })).toMatchObject({
      status: "valid",
      normalized: { mime: "image/png", size: PNG.length },
    });
  });

  it("uses the sniffed type when the browser declares nothing useful", () => {
    for (const declaredType of [undefined, null, "", "application/octet-stream"]) {
      expect(validateUpload("purchaseInvoice", { bytes: JPEG, declaredType })).toMatchObject({ status: "valid", normalized: { mime: "image/jpeg" } });
    }
    expect(validateUpload("purchaseInvoice", { bytes: JPEG, declaredType: "image/jpg" }).status).toBe("valid");
  });

  it.each([
    ["a renamed .txt", "purchaseInvoice", { bytes: TEXT, declaredType: "application/pdf", name: "invoice.pdf" }, "Please upload a PDF, JPEG, PNG or WebP file."],
    ["a 0-byte file", "purchaseInvoice", { bytes: Buffer.alloc(0), declaredType: "application/pdf" }, "That file is empty."],
    ["a file just over 10 MB", "purchaseInvoice", { bytes: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 1 - PDF.length)]) }, "That file is larger than 10 MB."],
    ["a PNG claiming to be a PDF", "purchaseInvoice", { bytes: PNG, declaredType: "application/pdf" }, "That file is labelled as a PDF but it's actually a PNG image."],
    ["a PDF claiming to be text", "purchaseInvoice", { bytes: PDF, declaredType: "text/plain" }, "That file is labelled as “text/plain” but it's actually a PDF."],
    // P2 audit: the photo message used to suggest a PDF, which photos then refuse.
    ["a HEIC photo", "additionalPhotos", { bytes: HEIC, declaredType: "image/heic" }, "HEIC photos aren't supported. Please upload a JPEG, PNG or WebP image instead."],
    ["a HEIC invoice", "purchaseInvoice", { bytes: HEIC, declaredType: "image/heic" }, "HEIC photos aren't supported. Please upload a PDF, JPEG, PNG or WebP file instead."],
    // P2 audit: a forged declared type named after an Object.prototype key used to print native code.
    ["a declared type of “constructor”", "purchaseInvoice", { bytes: PDF, declaredType: "constructor" }, "That file is labelled as “constructor” but it's actually a PDF."],
    ["a PDF as a photo", "additionalPhotos", { bytes: PDF, declaredType: "application/pdf" }, "Photos must be JPEG, PNG or WebP images."],
    ["a text file as a photo", "additionalPhotos", { bytes: TEXT }, "Photos must be JPEG, PNG or WebP images."],
  ] as const)("rejects %s", (_name, field, input, error) => {
    expect(validateUpload(field, input)).toEqual({ status: "invalid", error });
  });

  it("accepts exactly 10 MB", () => {
    const tenMb = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 - PDF.length)]);
    expect(validateUpload("purchaseInvoice", { bytes: tenMb })).toMatchObject({ status: "valid", normalized: { size: 10 * 1024 * 1024 } });
  });
});

describe("names and declared types", () => {
  it("keeps only a cleaned last path segment", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\invoice.pdf")).toBe("invoice.pdf");
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    expect(sanitizeFileName("in\u202Evoice.pdf")).toBe("invoice.pdf");
    expect([...(sanitizeFileName(`${"a".repeat(300)}.pdf`) ?? "")].length).toBeLessThanOrEqual(255);
    for (const empty of [null, undefined, "", "...", "/"]) expect(sanitizeFileName(empty)).toBeNull();
  });

  it("normalizes declared types", () => {
    expect(normalizeDeclaredType("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
    expect(normalizeDeclaredType("image/pjpeg")).toBe("image/jpeg");
    expect(normalizeDeclaredType("image/heif")).toBe("image/heic");
    expect(normalizeDeclaredType("application/octet-stream")).toBeNull();
  });
});

describe("file card answers (refs)", () => {
  it("parses file:<id> refs only", () => {
    expect(parseFileRef("file:fA3k9QzL2mXw")).toBe("fA3k9QzL2mXw");
    for (const bad of ["fA3k9QzL2mXw", "file:", "file:../../x", "file:abc", "https://x/y", 5, null]) expect(parseFileRef(bad)).toBeNull();
  });

  it("requires exactly one invoice", () => {
    expect(validateFileSelection("purchaseInvoice", "file:fA3k9QzL2mXw")).toEqual({ status: "valid", normalized: ["fA3k9QzL2mXw"] });
    expect(validateFileSelection("purchaseInvoice", ["file:fA3k9QzL2mXw"])).toEqual({ status: "valid", normalized: ["fA3k9QzL2mXw"] });
    expect(validateFileSelection("purchaseInvoice", null)).toEqual({ status: "invalid", error: "Please upload your purchase invoice." });
    expect(validateFileSelection("purchaseInvoice", [])).toEqual({ status: "invalid", error: "Please upload your purchase invoice." });
    expect(validateFileSelection("purchaseInvoice", ["file:aaaaaaaaaa", "file:bbbbbbbbbb"])).toEqual({ status: "invalid", error: "Please upload just one invoice file." });
    expect(validateFileSelection("purchaseInvoice", "nope")).toEqual({ status: "invalid", error: "That upload wasn't recognised. Please try again." });
  });

  it("allows 0–5 distinct photos, null meaning skipped", () => {
    expect(validateFileSelection("additionalPhotos", null)).toEqual({ status: "skipped" });
    expect(validateFileSelection("additionalPhotos", [])).toEqual({ status: "skipped" });
    const five = Array.from({ length: 5 }, (_, i) => `file:photo000${i}`);
    expect(validateFileSelection("additionalPhotos", five)).toEqual({ status: "valid", normalized: five.map((ref) => ref.slice(5)) });
    expect(validateFileSelection("additionalPhotos", [...five, "file:photo0005"])).toEqual({ status: "invalid", error: "You can add up to 5 photos." });
    expect(validateFileSelection("additionalPhotos", ["file:photo0001", "file:photo0001"])).toEqual({ status: "invalid", error: "The same photo was attached twice." });
    expect(validateFileSelection("additionalPhotos", ["file:photo0001", "x"])).toEqual({ status: "invalid", error: "One of the uploads wasn't recognised. Please try again." });
  });
});
