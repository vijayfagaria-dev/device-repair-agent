// Conflict detection and resolution (D15, P2-T05). Pure: the append-only candidate history of one field in, its
// effective value out. Nothing is ever overwritten; corrections are new candidates and the latest valid one counts.
import type { RecordFieldId } from "@device-repair/shared/fields";
import type { FieldSource } from "@device-repair/shared/protocol";
import { canonicalJson } from "./canonicalJson.js";
import { FIELDS } from "./fields.js";

export type CandidateStatus = "valid" | "invalid" | "skipped" | "unverified";

/** One offered value (a `field_candidates` row, architecture §4). */
export interface Candidate<T = unknown> {
  source: `${FieldSource}`;
  /** The event seq that recorded it: assigned under the session lock, so it is the commit order. */
  seq: number;
  /** Server time it was collected (ISO 8601). */
  collectedAt: string;
  status: CandidateStatus;
  /** The validator's normalized value (null unless the validator accepted it, or for chatOnly values heard on the call). */
  normalized: T | null;
  /** The user explicitly confirmed this value (read back on the call, or picked on a "which is correct?" card). */
  userConfirmed: boolean;
}

export type ResolvedStatus = "valid" | "invalid" | "missing" | "skipped" | "unverified";
export type ConflictResolution = "callValue" | "chatValue" | "same";

export interface FieldConflict {
  field: RecordFieldId;
  callValue: unknown;
  chatValue: unknown;
  resolution: ConflictResolution;
  reason: string;
  /**
   * An identifier conflict where the user had confirmed the losing (spoken) value: the agent should ask which is
   * correct (a conflictChoice card), and if it stays unresolved at finalization the outcome is needsReview (R-2).
   */
  unresolved: boolean;
}

export interface ResolvedField<T = unknown> {
  value: T | null;
  source: `${FieldSource}` | null;
  collectedAt: string | null;
  status: ResolvedStatus;
  /** Present whenever both channels hold a value, including equal ones (reported as corroboration). */
  conflict: FieldConflict | null;
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);
const pick = (value: unknown, key: string) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

/** What "the same value" means per field, after normalization. */
const COMPARABLE: Partial<Record<RecordFieldId, (value: unknown) => unknown>> = {
  email: lower,
  serialNumber: (value) => pick(value, "value"),
  serviceCentre: (value) => pick(value, "id"),
  deviceModel: (value) => [lower(pick(value, "brand")), lower(pick(value, "model"))],
  problemDescription: (value) => lower(pick(value, "verbatim")),
  problemStartedAt: (value) => pick(value, "date"),
  urgency: (value) => pick(value, "level"),
};

export function sameValue(field: RecordFieldId, a: unknown, b: unknown): boolean {
  const comparable = COMPARABLE[field] ?? ((value: unknown) => value);
  return canonicalJson(comparable(a) ?? null) === canonicalJson(comparable(b) ?? null);
}

/**
 * A total order on candidates: commit order (seq) first. Ties (several candidates from one event) fall back to time,
 * then source, then the value itself, so the result never depends on the order rows were read in.
 */
function isLater(a: Candidate<unknown>, b: Candidate<unknown>): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  if (a.collectedAt !== b.collectedAt) return a.collectedAt > b.collectedAt;
  if (a.source !== b.source) return a.source === "chat";
  if (a.status !== b.status) return a.status > b.status;
  return canonicalJson(a.normalized ?? null) > canonicalJson(b.normalized ?? null);
}

const latest = <T>(candidates: readonly Candidate<T>[], test: (c: Candidate<T>) => boolean): Candidate<T> | null => {
  let found: Candidate<T> | null = null;
  for (const candidate of candidates) if (test(candidate) && (found === null || isLater(candidate, found))) found = candidate;
  return found;
};

const fromCandidate = <T>(candidate: Candidate<T>, status: ResolvedStatus, conflict: FieldConflict | null = null): ResolvedField<T> => ({
  value: status === "valid" || status === "unverified" ? candidate.normalized : null,
  source: candidate.source,
  collectedAt: candidate.collectedAt,
  status,
  conflict,
});

/** Both channels hold a value: apply the field's conflict class (D15). */
function resolveBoth<T>(field: RecordFieldId, call: Candidate<T>, chat: Candidate<T>): ResolvedField<T> {
  const conflict = (resolution: ConflictResolution, reason: string, unresolved = false): FieldConflict => ({
    field,
    callValue: call.normalized,
    chatValue: chat.normalized,
    resolution,
    reason,
    unresolved,
  });
  const definition = FIELDS[field];

  if (sameValue(field, call.normalized, chat.normalized)) {
    // Corroboration, not a conflict. The value shown comes from the source the policy would have preferred.
    const winner = definition.conflictClass === "narrative" ? call : definition.conflictClass === "choice" && isLater(call, chat) ? call : chat;
    return fromCandidate(winner, "valid", conflict("same", "values equal after normalization"));
  }
  switch (definition.conflictClass) {
    case "identifier": {
      // Typed always wins. If the user had confirmed the spoken value (and hasn't since confirmed the typed one),
      // a human or a "which is correct?" card must decide (D15 escalation).
      const unresolved = call.userConfirmed && !chat.userConfirmed;
      const reason = unresolved
        ? "typed value used, but the user had confirmed the spoken value; needs confirmation"
        : "typed value preferred over spoken for identifiers";
      return fromCandidate(chat, "valid", conflict("chatValue", reason, unresolved));
    }
    case "typedPreferred":
      return fromCandidate(chat, "valid", conflict("chatValue", "typed value preferred for spelling"));
    case "narrative":
      return fromCandidate(call, "valid", conflict("callValue", "spoken account preferred; typed version kept as an addendum"));
    case "choice": {
      const recent = isLater(call, chat) ? call : chat;
      return fromCandidate(recent, "valid", conflict(recent === call ? "callValue" : "chatValue", "most recent explicit choice"));
    }
    default:
      // chatInput fields never get here: their call candidates are ignored.
      return fromCandidate(chat, "valid");
  }
}

/**
 * The effective value of one field from its full candidate history. Deterministic: the same history always gives
 * the same result, in any input order.
 */
export function resolveField<T = unknown>(field: RecordFieldId, history: readonly Candidate<T>[]): ResolvedField<T> {
  const definition = FIELDS[field];
  const candidates = definition.conflictClass === "chatInput" ? history.filter((c) => c.source === "chat") : history;
  const chat = latest(candidates, (c) => c.source === "chat" && c.status === "valid");
  // chatOnly identifiers: a value heard on the call never counts as valid; it is "heard, needs typing".
  const call =
    definition.authority === "chatOnly"
      ? latest(candidates, (c) => c.source === "call" && (c.status === "valid" || c.status === "unverified"))
      : latest(candidates, (c) => c.source === "call" && c.status === "valid");

  if (chat && call) return resolveBoth(field, call, chat);
  if (chat) return fromCandidate(chat, "valid");
  if (call) return fromCandidate(call, definition.authority === "chatOnly" ? "unverified" : "valid");

  const last = latest(candidates, () => true);
  if (!last) return { value: null, source: null, collectedAt: null, status: "missing", conflict: null };
  return fromCandidate(last, last.status === "skipped" ? "skipped" : "invalid");
}
