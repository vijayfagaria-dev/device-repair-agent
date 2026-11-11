// Upload checks (D10, P2-T04), pure: the type comes from the file's magic bytes, never from its name or the browser's
// claim; a claimed type that disagrees with the contents is rejected. HEIC is recognised only so it can be rejected
// with a clear message (P0-T01). The upload endpoint (P4-T03) streams, stores and signs; these only decide.
import { createHash } from "node:crypto";
import { ACCEPTED_FILE_TYPES, type AcceptedFileType } from "@device-repair/shared/fields";
import { MAX_ADDITIONAL_PHOTOS, MAX_FILE_BYTES } from "../fields.js";
import { invalid, skipped, valid, type ValidationResult } from "./result.js";
import { cleanText, truncate } from "./strings.js";

export type FileField = "purchaseInvoice" | "additionalPhotos";
export type SniffedType = AcceptedFileType | "image/heic";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** The file's real type from its first bytes, or null when it's none of the types we recognise. */
export function sniffFileType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("ftyp"), 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (HEIF_BRANDS.has(brand)) return "image/heic";
  }
  return null;
}

const TYPE_NAMES: Record<string, string> = {
  "application/pdf": "a PDF",
  "image/jpeg": "a JPEG image",
  "image/png": "a PNG image",
  "image/webp": "a WebP image",
  "image/heic": "a HEIC photo",
};
// Own keys only: the declared type comes from the client, and "constructor" must not find Object.prototype's.
const describeType = (type: string) => (Object.hasOwn(TYPE_NAMES, type) ? TYPE_NAMES[type] : `“${type}”`);

/** The browser's declared type, normalised; null when it declared nothing useful (empty or octet-stream). */
export function normalizeDeclaredType(declared: string | null | undefined): string | null {
  const type = (declared ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type === "" || type === "application/octet-stream") return null;
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  if (type === "image/heif") return "image/heic";
  return type;
}

/** What the files table stores for an accepted upload; the record later adds the file id and a signed URL. */
export interface CheckedFile {
  mime: AcceptedFileType;
  size: number;
  sha256: string;
  originalName: string | null;
}

export interface UploadInput {
  bytes: Uint8Array;
  declaredType?: string | null;
  /** The name the browser sent: display only, never a path. */
  name?: string | null;
}

const FIELD_TYPES: Record<FileField, readonly AcceptedFileType[]> = {
  purchaseInvoice: ACCEPTED_FILE_TYPES,
  additionalPhotos: ACCEPTED_FILE_TYPES.filter((type) => type.startsWith("image/")),
};

export const MAX_FILE_NAME_CHARS = 255;

/** Keeps the last path segment, cleaned and capped, so a name can never act as a path. */
export function sanitizeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = cleanText(name).split(/[\\/]/).pop() ?? "";
  const cleaned = truncate(base.replace(/^\.+/, ""), MAX_FILE_NAME_CHARS);
  return cleaned === "" ? null : cleaned;
}

export function validateUpload(field: FileField, { bytes, declaredType, name }: UploadInput): ValidationResult<CheckedFile> {
  if (bytes.length === 0) return invalid("That file is empty.");
  if (bytes.length > MAX_FILE_BYTES) return invalid("That file is larger than 10 MB.");
  const sniffed = sniffFileType(bytes);
  if (sniffed === "image/heic") {
    // Name only what this field accepts: a PDF is fine for the invoice but not as a photo.
    return invalid(
      field === "additionalPhotos"
        ? "HEIC photos aren't supported. Please upload a JPEG, PNG or WebP image instead."
        : "HEIC photos aren't supported. Please upload a PDF, JPEG, PNG or WebP file instead.",
    );
  }
  const allowed = FIELD_TYPES[field];
  if (sniffed === null) {
    return invalid(field === "additionalPhotos" ? "Photos must be JPEG, PNG or WebP images." : "Please upload a PDF, JPEG, PNG or WebP file.");
  }
  const declared = normalizeDeclaredType(declaredType);
  if (declared !== null && declared !== sniffed) {
    return invalid(`That file is labelled as ${describeType(declared)} but it's actually ${describeType(sniffed)}.`);
  }
  if (!allowed.includes(sniffed)) return invalid("Photos must be JPEG, PNG or WebP images.");
  return valid({
    mime: sniffed,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    originalName: sanitizeFileName(name),
  });
}

/** `file:<fileId>`, the opaque upload reference (protocol.md §8). Ids are server-generated base64url. */
const FILE_REF = /^file:([A-Za-z0-9_-]{8,64})$/;

export function parseFileRef(value: unknown): string | null {
  return typeof value === "string" ? (FILE_REF.exec(value)?.[1] ?? null) : null;
}

/**
 * The answer to a file card: one ref for the invoice; 0–5 refs for photos (null = skipped). Returns the file ids;
 * whether each file exists and belongs to this session is checked against the database by the caller (P4-T02).
 */
export function validateFileSelection(field: FileField, value: unknown): ValidationResult<string[]> {
  if (field === "purchaseInvoice") {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return invalid("Please upload your purchase invoice.");
    }
    if (Array.isArray(value) && value.length > 1) return invalid("Please upload just one invoice file.");
    const id = parseFileRef(Array.isArray(value) ? value[0] : value);
    return id ? valid([id]) : invalid("That upload wasn't recognised. Please try again.");
  }
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return skipped();
  const refs = Array.isArray(value) ? value : [value];
  if (refs.length > MAX_ADDITIONAL_PHOTOS) return invalid(`You can add up to ${MAX_ADDITIONAL_PHOTOS} photos.`);
  const ids = refs.map(parseFileRef);
  if (ids.some((id) => id === null)) return invalid("One of the uploads wasn't recognised. Please try again.");
  if (new Set(ids).size !== ids.length) return invalid("The same photo was attached twice.");
  return valid(ids as string[]);
}
