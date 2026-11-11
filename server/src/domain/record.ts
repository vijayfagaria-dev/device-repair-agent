// The final record (architecture §7, D17, P2-T07): the sanitized, structured output the business receives. Pure apart
// from SHA-256: everything it needs (resolved fields, the outcome decision, engagement, cost, a file-URL signer) is
// passed in. The sanitization pipeline below is applied in this order on every build.
import { createHash } from "node:crypto";
import {
  type FileDescriptor,
  RECORD_FIELD_IDS,
  type RecordFieldId,
} from "@device-repair/shared/fields";
import type { FinalRecord, Outcome } from "@device-repair/shared/protocol";
import recordSchema from "@device-repair/shared/record.schema.json" with { type: "json" };
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { canonicalJson } from "./canonicalJson.js";
import type { ResolvedField, ResolvedStatus } from "./conflicts.js";
import { toIstIso } from "./dates.js";
import type { ReviewFlag } from "./outcome.js";
import { cleanText, truncate } from "./validators/strings.js";

export const RECORD_SCHEMA_VERSION = "1.0";

export interface Engagement {
  calls: number;
  callSeconds: number;
  chatMessages: number;
  chatInputsSubmitted: number;
  invalidAttempts: number;
}

export interface CostBreakdown {
  stt: number;
  llm: number;
  tts: number;
  vision: number;
}

export interface RecordFieldEntry {
  value: unknown;
  source: "call" | "chat" | null;
  collectedAt: string | null;
  status: ResolvedStatus;
}

export interface RecordConflictEntry {
  field: RecordFieldId;
  callValue: unknown;
  chatValue: unknown;
  resolution: "callValue" | "chatValue" | "same";
  reason: string;
}

/** The record as delivered. Assignable to the wire type `FinalRecord`, which the starter UI renders. */
export interface ClaimRecord extends FinalRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  sessionId: string;
  revision: number;
  outcome: Outcome;
  outcomeReason: string;
  previousRevision: { revision: number; outcome: Outcome } | null;
  fields: Record<RecordFieldId, RecordFieldEntry>;
  missingRequired: RecordFieldId[];
  conflicts: RecordConflictEntry[];
  reviewFlags: ReviewFlag[];
  submitConfirmation: { confirmed: true; source: "chat"; at: string } | null;
  engagement: Engagement;
  costUsd: number;
  costBreakdownUsd: CostBreakdown;
  actualSpendUsd: number;
  createdAt: string;
  endedAt: string;
}

/** A stored upload as the candidate holds it; the builder adds the signed URL. */
export type StoredFile = Omit<FileDescriptor, "url">;

export interface RecordInput {
  sessionId: string;
  revision: number;
  previousRevision: { revision: number; outcome: Outcome } | null;
  /** From decideOutcome (a finalizing decision). */
  outcome: Outcome;
  outcomeReason: string;
  reviewFlags: readonly ReviewFlag[];
  missingRequired: readonly RecordFieldId[];
  /** Resolved fields (conflicts.ts), one per record field. */
  fields: Readonly<Record<RecordFieldId, ResolvedField>>;
  /** When the user tapped Yes on "Submit claim?", if they did since the session was last opened. */
  submitConfirmedAt: string | null;
  engagement: Engagement;
  cost: { costUsd: number; costBreakdownUsd: CostBreakdown; actualSpendUsd: number };
  /** When the session reached its end state (e.g. the idle timer's due time). */
  endedAt: Date;
  now: Date;
  /** Signed, expiring download URL for a stored file (D10; implemented with the upload endpoint, P4-T03). */
  signFileUrl: (fileId: string) => string;
}

export class RecordSchemaError extends Error {
  /** Where the record broke its schema (JSON pointers and keywords only; never the values). */
  readonly problems: readonly { path: string; keyword: string; message: string }[];

  constructor(errors: readonly ErrorObject[]) {
    const problems = errors.map((e) => ({ path: e.instancePath || "/", keyword: e.keyword, message: e.message ?? "" }));
    super(`record failed its schema: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
    this.name = "RecordSchemaError";
    this.problems = problems;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile<ClaimRecord>(recordSchema);

// ---------------------------------------------------------------------------------------------------------------------
// Steps 1, 2 and 4: string hygiene, per-field shape, internal fields stripped. Each value is rebuilt from the keys the
// schema allows, so evidence strings, raw input or file paths a candidate might carry can never reach the record.

const text = (value: unknown, max: number, multiline = false): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = truncate(cleanText(value, { multiline }), max);
  return cleaned === "" ? null : cleaned;
};
const get = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

function fileValue(value: unknown, sign: (fileId: string) => string): FileDescriptor | null {
  const fileId = get(value, "fileId");
  if (typeof fileId !== "string") return null;
  return { fileId, mime: get(value, "mime") as FileDescriptor["mime"], size: get(value, "size") as number, sha256: get(value, "sha256") as string, url: sign(fileId) };
}

/** Projects a resolved value onto exactly the shape the schema allows for that field. */
export function projectValue(field: RecordFieldId, value: unknown, sign: (fileId: string) => string): unknown {
  if (value === null || value === undefined) return null;
  switch (field) {
    case "deviceType":
    case "email":
      return text(value, 254);
    case "additionalNotes":
      return text(value, 1000, true); // notes keep their line breaks
    case "deviceModel":
      return { brand: text(get(value, "brand"), 80), model: text(get(value, "model"), 80) };
    case "problemDescription":
      return { summary: text(get(value, "summary"), 300), verbatim: text(get(value, "verbatim"), 1000) };
    case "problemStartedAt":
      return { date: get(value, "date") ?? null, precision: get(value, "precision") ?? null, spoken: text(get(value, "spoken"), 200) };
    case "urgency":
      return { level: get(value, "level") ?? null, reason: text(get(value, "reason"), 200) };
    case "serialNumber":
      return { kind: get(value, "kind") ?? null, value: get(value, "value") ?? null };
    case "serviceCentre":
      return { id: get(value, "id") ?? null, name: text(get(value, "name"), 100), city: text(get(value, "city"), 60) };
    case "purchaseInvoice":
      return fileValue(value, sign);
    case "additionalPhotos":
      return Array.isArray(value) ? value.map((item) => fileValue(item, sign)) : null;
  }
}

/** Used when a stored flag's reason is empty after cleaning, so every flag still says why. */
const RULE_DESCRIPTIONS: Record<ReviewFlag["rule"], string> = {
  "R-1": "safety hazard reported",
  "R-2": "identifier conflict unresolved",
  "R-3": "required field invalid after 3 attempts",
  "R-4": "uploaded file flagged by the vision check",
  "R-5": "flagged for review by the agent",
};

const timestamp = (iso: string | null): string | null => (iso === null ? null : toIstIso(new Date(iso)));

/** Same value with file URLs removed: signed URLs change on every build and must not create a revision. */
export function withoutFileUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFileUrls);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "url").map(([key, item]) => [key, withoutFileUrls(item)]));
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON of the parts that define the claim (D17): outcome, outcomeReason, fields,
 * missingRequired, conflicts, reviewFlags, submitConfirmation. Engagement, cost and timestamps of the build itself are
 * excluded, so they alone never create a new revision; so are signed file URLs.
 */
export function contentHash(record: ClaimRecord): string {
  const scope = {
    outcome: record.outcome,
    outcomeReason: record.outcomeReason,
    fields: withoutFileUrls(record.fields),
    missingRequired: record.missingRequired,
    conflicts: record.conflicts,
    reviewFlags: record.reviewFlags,
    submitConfirmation: record.submitConfirmation,
  };
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

export function validateRecord(record: unknown): asserts record is ClaimRecord {
  if (!validateSchema(record)) throw new RecordSchemaError(validateSchema.errors ?? []);
}

/** Builds, validates (step 7) and hashes (step 8) the record. Throws RecordSchemaError if the result is invalid. */
export function buildRecord(input: RecordInput): { record: ClaimRecord; contentHash: string } {
  const fields = {} as Record<RecordFieldId, RecordFieldEntry>;
  const conflicts: RecordConflictEntry[] = [];
  // Step 6: keys are written in a fixed order (catalog order for fields; the order below for the record).
  for (const id of RECORD_FIELD_IDS) {
    const resolved = input.fields[id];
    fields[id] = {
      value: projectValue(id, resolved.value, input.signFileUrl), // step 5: files become signed descriptors
      source: resolved.source,
      collectedAt: timestamp(resolved.collectedAt),
      status: resolved.status,
    };
    const conflict = resolved.conflict;
    if (conflict) {
      conflicts.push({
        field: id,
        callValue: withoutFileUrls(projectValue(id, conflict.callValue, input.signFileUrl)),
        chatValue: withoutFileUrls(projectValue(id, conflict.chatValue, input.signFileUrl)),
        resolution: conflict.resolution,
        reason: truncate(cleanText(conflict.reason), 300),
      });
    }
  }

  const record: ClaimRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sessionId: input.sessionId,
    revision: input.revision,
    outcome: input.outcome,
    outcomeReason: truncate(cleanText(input.outcomeReason), 1000),
    previousRevision: input.previousRevision ? { revision: input.previousRevision.revision, outcome: input.previousRevision.outcome } : null,
    fields,
    missingRequired: [...input.missingRequired],
    conflicts,
    reviewFlags: input.reviewFlags.map((flag) => ({ rule: flag.rule, reason: truncate(cleanText(flag.reason), 300) || RULE_DESCRIPTIONS[flag.rule] })),
    submitConfirmation: input.submitConfirmedAt ? { confirmed: true, source: "chat", at: toIstIso(new Date(input.submitConfirmedAt)) } : null,
    engagement: {
      calls: input.engagement.calls,
      callSeconds: input.engagement.callSeconds,
      chatMessages: input.engagement.chatMessages,
      chatInputsSubmitted: input.engagement.chatInputsSubmitted,
      invalidAttempts: input.engagement.invalidAttempts,
    },
    costUsd: input.cost.costUsd,
    costBreakdownUsd: {
      stt: input.cost.costBreakdownUsd.stt,
      llm: input.cost.costBreakdownUsd.llm,
      tts: input.cost.costBreakdownUsd.tts,
      vision: input.cost.costBreakdownUsd.vision,
    },
    actualSpendUsd: input.cost.actualSpendUsd,
    createdAt: toIstIso(input.now),
    endedAt: toIstIso(input.endedAt),
  };
  validateRecord(record);
  return { record, contentHash: contentHash(record) };
}
