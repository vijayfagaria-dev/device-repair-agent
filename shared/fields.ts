// Field catalog types (D14): the claim's fields, how each is collected, and the normalized value each one holds in
// the final record. The catalog itself (labels, cards, validators) lives on the server: server/src/domain/fields.ts.
import type { InputRequest } from "./protocol/index.js";

/** Collected conversationally on the call (each also has a chat-card fallback, PD5). */
export const CALL_FIELDS = ["deviceType", "deviceModel", "problemDescription", "problemStartedAt", "urgency"] as const;
/** Awkward by voice, so collected in chat. */
export const CHAT_FIELDS = ["serialNumber", "purchaseInvoice", "serviceCentre", "email"] as const;
/** Offered once near the end and skippable (PD4). */
export const OPTIONAL_FIELDS = ["additionalPhotos", "additionalNotes"] as const;
/** The explicit "Submit claim?" confirmation (PD2). Not a record field: the record has a `submitConfirmation` block. */
export const CONFIRMATION_FIELD = "submitConfirmation";

/** Keys of `record.fields`, in record order. */
export const RECORD_FIELD_IDS = [...CALL_FIELDS, ...CHAT_FIELDS, ...OPTIONAL_FIELDS] as const;
export const FIELD_IDS = [...RECORD_FIELD_IDS, CONFIRMATION_FIELD] as const;

export type CallFieldId = (typeof CALL_FIELDS)[number];
export type ChatFieldId = (typeof CHAT_FIELDS)[number];
export type OptionalFieldId = (typeof OPTIONAL_FIELDS)[number];
export type RecordFieldId = (typeof RECORD_FIELD_IDS)[number];
export type FieldId = (typeof FIELD_IDS)[number];

export type FieldChannel = "call" | "chat";
/**
 * `chatOnly`: an identifier that must be typed (D13). A value heard on the call is stored as `unverified` and never
 * satisfies the field. `either`: a valid value from either channel counts.
 */
export type FieldAuthority = "chatOnly" | "either";
/** Conflict policy when both channels hold different valid values (D15). */
export type ConflictClass =
  /** serialNumber, email: the typed (chat) value always wins. */
  | "identifier"
  /** deviceType, serviceCentre: the most recent explicit choice wins. */
  | "choice"
  /** problemDescription, problemStartedAt, urgency: the spoken (call) value wins; the chat one is kept as an addendum. */
  | "narrative"
  /** deviceModel: the typed value wins (spelling), else the spoken one. */
  | "typedPreferred"
  /** Files, notes, the confirmation: chat only; call candidates are ignored. */
  | "chatInput";

/** A chat card for the field: the wire `inputRequest` without its per-request parts. */
export type CardSpec = Omit<InputRequest, "type" | "id" | "field">;

export interface FieldDefinition {
  id: FieldId;
  /** Short human label ("serial number"), used in messages and acknowledgements. */
  label: string;
  /** One line for the agent's prompt: what the field means and how to collect it. */
  description: string;
  primaryChannel: FieldChannel;
  required: boolean;
  authority: FieldAuthority;
  /** Whether the call agent may store a spoken value for it (save_field). */
  spokenCapture: boolean;
  conflictClass: ConflictClass;
  card: CardSpec;
}

// Normalized values (what `record.fields[id].value` holds when the field is valid).
export const DEVICE_TYPES = ["smartphone", "laptop", "tablet", "smartwatch", "headphones", "other"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export const URGENCY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
export const DATE_PRECISIONS = ["day", "week", "month"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];
export const ACCEPTED_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedFileType = (typeof ACCEPTED_FILE_TYPES)[number];

/** brand and model both null = the user didn't know, accepted after one re-ask (D14). */
export interface DeviceModelValue {
  brand: string | null;
  model: string | null;
}
export interface ProblemDescriptionValue {
  summary: string;
  verbatim: string;
}
export interface ProblemStartedAtValue {
  /**
   * YYYY-MM-DD in IST: the best estimate. `precision` says how exact it is ("this week" → that Monday, precision week;
   * "last month" → the 1st, precision month; "two weeks ago" → 14 days back, precision week).
   */
  date: string;
  precision: DatePrecision;
  /** The words the user used ("last Tuesday"), when it was spoken. */
  spoken: string | null;
}
export interface UrgencyValue {
  level: UrgencyLevel;
  reason: string | null;
}
export interface SerialNumberValue {
  kind: "imei" | "serial";
  value: string;
}
export interface ServiceCentreValue {
  id: string;
  name: string;
  city: string;
}
/** A stored upload as it appears in the record: metadata plus a signed, expiring download URL (D10). */
export interface FileDescriptor {
  fileId: string;
  mime: AcceptedFileType;
  size: number;
  sha256: string;
  url: string;
}

export interface FieldValues {
  deviceType: DeviceType;
  deviceModel: DeviceModelValue;
  problemDescription: ProblemDescriptionValue;
  problemStartedAt: ProblemStartedAtValue;
  urgency: UrgencyValue;
  serialNumber: SerialNumberValue;
  purchaseInvoice: FileDescriptor;
  serviceCentre: ServiceCentreValue;
  email: string;
  additionalPhotos: FileDescriptor[];
  additionalNotes: string;
}
