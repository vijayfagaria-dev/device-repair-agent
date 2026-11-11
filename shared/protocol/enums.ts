export enum Role {
  USER = "user",
  AGENT = "agent",
}

export enum CallServerMessageType {
  AUDIO = "audio",
  STOP_PLAYBACK = "stopPlayback",
  TRANSCRIPT = "transcript",
}

export enum ChatServerMessageType {
  MESSAGE = "message",
  INPUT_REQUEST = "inputRequest",
  INPUT_ERROR = "inputError",
  INPUT_CANCEL = "inputCancel",
  RECORD = "record",
  // Added by protocol.md v1.0 (§3.3), after the starter's five.
  /** A final call transcript line, replayed on /chat (same shape and id as on /call). */
  TRANSCRIPT = "transcript",
  SESSION_STATE = "sessionState",
  SYNC_DONE = "syncDone",
}

export enum ChatClientMessageType {
  INPUT_RESPONSE = "inputResponse",
  // Added by protocol.md v1.0 (§3.4).
  OPT_OUT = "optOut",
  CLIENT_METRIC = "clientMetric",
}

export enum InputKind {
  TEXT = "text",
  EMAIL = "email",
  PHONE = "phone",
  NUMBER = "number",
  DATE = "date",
  SELECT = "select",
  MULTI_SELECT = "multiSelect",
  FILE = "file",
  CONFIRM = "confirm",
}

export enum Outcome {
  COMPLETED = "completed",
  PARTIAL = "partial",
  OPTED_OUT = "optedOut",
  NEEDS_REVIEW = "needsReview",
}

export enum FieldSource {
  CALL = "call",
  CHAT = "chat",
}

export enum FieldStatus {
  VALID = "valid",
  MISSING = "missing",
  INVALID = "invalid",
  /** An optional field the user explicitly skipped (protocol.md §9, P2-T07). */
  SKIPPED = "skipped",
  /** An identifier heard only on the call: noted, never accepted until typed (D13). */
  UNVERIFIED = "unverified",
}
