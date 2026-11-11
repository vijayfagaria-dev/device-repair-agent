// Builders for domain tests: candidates, resolved field sets and a deterministic PRNG for property/fuzz tests.
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import type { Candidate, ResolvedField } from "../../src/domain/conflicts.js";

let seq = 0;

/** A candidate with an increasing seq (call order = commit order), collected one second apart. */
export function candidate<T>(source: "call" | "chat", status: Candidate["status"], normalized: T | null, extra: Partial<Candidate<T>> = {}): Candidate<T> {
  seq += 1;
  return {
    source,
    seq,
    collectedAt: new Date(Date.UTC(2026, 10, 7, 4, 30, seq)).toISOString(),
    status,
    normalized,
    userConfirmed: false,
    ...extra,
  };
}

export const valid = <T>(source: "call" | "chat", value: T, extra: Partial<Candidate<T>> = {}) => candidate(source, "valid", value, extra);

/** One resolved field with the given status (a value is required for valid/unverified). */
export function resolved(status: ResolvedField["status"], value: unknown = null, source: "call" | "chat" | null = null): ResolvedField {
  const present = status !== "missing";
  return {
    value: status === "valid" || status === "unverified" ? value : null,
    source: present ? (source ?? "chat") : null,
    collectedAt: present ? "2026-11-07T04:31:00.000Z" : null,
    status,
    conflict: null,
  };
}

export const FILE = { fileId: "fInvoice000001", mime: "application/pdf", size: 18233, sha256: "a".repeat(64) } as const;
export const PHOTO = { fileId: "fPhoto00000001", mime: "image/jpeg", size: 52011, sha256: "b".repeat(64) } as const;

/** A valid normalized value for every record field (what the validators produce). */
export const VALID_VALUES: Record<RecordFieldId, unknown> = {
  deviceType: "smartphone",
  deviceModel: { brand: "Apple", model: "iPhone 14 Pro" },
  problemDescription: { summary: "Screen flickers and goes black after a drop", verbatim: "the screen flickers and then goes black, it started after I dropped it" },
  problemStartedAt: { date: "2026-11-03", precision: "day", spoken: "last Tuesday" },
  urgency: { level: "high", reason: "need it for work" },
  serialNumber: { kind: "imei", value: "352099001761481" },
  purchaseInvoice: FILE,
  serviceCentre: { id: "blr-koramangala", name: "Koramangala Demo Repair Centre", city: "Bengaluru" },
  email: "asha.rao@example.com",
  additionalPhotos: [PHOTO],
  additionalNotes: "Please call before visiting.",
};

const CHAT_SOURCED = new Set<RecordFieldId>(["serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"]);

/** Every field valid, except the overrides. */
export function allValid(overrides: Partial<Record<RecordFieldId, ResolvedField>> = {}): Record<RecordFieldId, ResolvedField> {
  return Object.fromEntries(
    RECORD_FIELD_IDS.map((id) => [id, overrides[id] ?? resolved("valid", VALID_VALUES[id], CHAT_SOURCED.has(id) ? "chat" : "call")]),
  ) as Record<RecordFieldId, ResolvedField>;
}

/** Mulberry32: a small seeded PRNG, so property and fuzz tests are reproducible. */
export function prng(seedValue: number) {
  let state = seedValue >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}
