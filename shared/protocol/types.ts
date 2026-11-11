import type {
  CallServerMessageType,
  ChatClientMessageType,
  ChatServerMessageType,
  FieldSource,
  FieldStatus,
  InputKind,
  Outcome,
  Role,
} from "./enums.js";

export interface AudioMessage {
  type: CallServerMessageType.AUDIO;
  sampleRate?: number; // defaults to DEFAULT_PLAYBACK_RATE
  data: string;
}

export interface StopPlaybackMessage {
  type: CallServerMessageType.STOP_PLAYBACK;
}

export interface TranscriptMessage {
  type: CallServerMessageType.TRANSCRIPT;
  role: Role;
  text: string;
  final: boolean;
  id?: string;
}

export type CallServerMessage = AudioMessage | StopPlaybackMessage | TranscriptMessage;

export interface ChatMessage {
  type: ChatServerMessageType.MESSAGE;
  role: Role;
  text: string;
  id?: string;
  /**
   * Role `user` only: the input card this message answers (protocol.md v1.2, additive). Lets the client skip a
   * replayed answer it is already showing as its own answer bubble (reconnect without a reload).
   */
  requestId?: string;
}

export interface InputOption {
  value: string;
  label?: string;
}

export interface InputRequest {
  type: ChatServerMessageType.INPUT_REQUEST;
  id: string;
  field: string;
  kind: InputKind;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  pattern?: string; // JavaScript RegExp source, checked before sending
  options?: InputOption[]; // select, multiSelect
  accept?: string; // file: same syntax as <input accept>, e.g. "image/*,.pdf"
  multiple?: boolean; // file: value becomes an array of URLs
}

export interface InputError {
  type: ChatServerMessageType.INPUT_ERROR;
  id?: string; // err_<requestId>_<attempt> (protocol.md §1.1); always sent by the server
  requestId: string;
  message?: string;
}

export interface InputCancel {
  type: ChatServerMessageType.INPUT_CANCEL;
  id?: string; // cancel_<requestId>; always sent by the server
  requestId: string;
  reason?: string;
}

export interface RecordMessage {
  type: ChatServerMessageType.RECORD;
  id?: string; // rec_<revision>; always sent by the server
  record: FinalRecord;
}

/** A final call transcript line replayed on /chat (protocol.md §3.3). Same id as the line had on /call. */
export interface ChatTranscriptMessage {
  type: ChatServerMessageType.TRANSCRIPT;
  id: string;
  role: Role;
  text: string;
  final: boolean;
}

export type SessionStatus = "active" | "finalized" | "closed";

/** Sent after replay and whenever one of its values changes (protocol.md §3.3). */
export interface SessionStateMessage {
  type: ChatServerMessageType.SESSION_STATE;
  id: string; // state_<version>
  status: SessionStatus;
  callActive: boolean;
  outcome: `${Outcome}` | null;
  revision: number | null;
  voiceAvailable: boolean;
  notice: string | null;
}

/** Ends the replay: live messages after it are newer than `lastSeq` (protocol.md §4). */
export interface SyncDoneMessage {
  type: ChatServerMessageType.SYNC_DONE;
  id: string; // sync_<lastSeq>
  lastSeq: number;
}

export type ChatServerMessage =
  | ChatMessage
  | InputRequest
  | InputError
  | InputCancel
  | RecordMessage
  | ChatTranscriptMessage
  | SessionStateMessage
  | SyncDoneMessage;

export type InputValue = string | number | boolean | string[] | null;

export interface InputResponse {
  type: ChatClientMessageType.INPUT_RESPONSE;
  requestId: string;
  field: string;
  value: InputValue;
}

/** The chat Stop button (protocol.md §3.4; P4-T05). */
export interface OptOutRequest {
  type: ChatClientMessageType.OPT_OUT;
}

/** Client-side turn latency probe (protocol.md §3.4; P11-T02). */
export interface ClientMetric {
  type: ChatClientMessageType.CLIENT_METRIC;
  name: "turnLatency";
  turnId: string;
  ms: number;
  at: string;
}

export type ChatClientMessage = InputResponse | OptOutRequest | ClientMetric;

export interface UploadResponse {
  url: string;
}

export interface RecordField {
  value: unknown;
  // The enums' string values, so a record built as plain JSON (server/src/domain/record.ts) is also a FinalRecord.
  source: `${FieldSource}` | null;
  collectedAt: string | null; // ISO 8601 with offset
  status: `${FieldStatus}`;
}

export interface RecordConflict {
  field: string;
  callValue: unknown;
  chatValue: unknown;
  resolution: string;
  reason: string;
}

export interface FinalRecord {
  sessionId: string;
  revision: number;
  outcome: Outcome;
  outcomeReason?: string;
  fields: Record<string, RecordField>;
  conflicts?: RecordConflict[];
  engagement?: { calls: number; callSeconds: number; chatMessages: number };
  costUsd?: number;
  endedAt?: string;
}
