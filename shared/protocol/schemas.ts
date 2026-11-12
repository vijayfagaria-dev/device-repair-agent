// Zod schemas for the /chat messages (protocol.md §3.3–§3.4). The server validates every inbound message with these;
// tests validate what the server sends. Exported as `@voice-chat-agent/shared/protocol/schemas`, not from the protocol
// index, so the browser bundle never pulls in zod. The /call schemas come with P5-T02.
import { z } from "zod";
import { ChatClientMessageType, ChatServerMessageType, InputKind, Outcome, Role } from "./enums.js";

/** protocol.md §7: inputResponse strings are capped at 1,000 characters (stricter per-field limits apply later). */
export const MAX_INPUT_STRING_CHARS = 1000;
/** A file card answers with at most this many refs (12 files per session, protocol.md §8). */
export const MAX_INPUT_ARRAY_ITEMS = 12;
/** Ids we generate are short; anything longer is not one of ours. */
const MAX_ID_CHARS = 128;

const id = z.string().min(1).max(MAX_ID_CHARS);
const shortString = z.string().max(MAX_INPUT_STRING_CHARS);

// ---------------------------------------------------------------------------------------------------------------------
// Client → server (§3.4). Unknown keys are stripped (forward compatible); a wrong shape is dropped by the server.

export const InputValueSchema = z.union([
  shortString,
  z.number().refine(Number.isFinite, "must be finite"),
  z.boolean(),
  z.array(shortString).max(MAX_INPUT_ARRAY_ITEMS),
  z.null(),
]);

export const ChatInputResponseSchema = z.object({
  type: z.literal(ChatClientMessageType.INPUT_RESPONSE),
  requestId: id,
  field: z.string().min(1).max(64),
  value: InputValueSchema,
});

export const ChatOptOutSchema = z.object({ type: z.literal(ChatClientMessageType.OPT_OUT) });

export const ChatClientMetricSchema = z.object({
  type: z.literal(ChatClientMessageType.CLIENT_METRIC),
  name: z.literal("turnLatency"),
  turnId: id,
  ms: z.number().min(0).max(60_000),
  at: z.string().min(1).max(40),
});

export const ChatClientMessageSchema = z.discriminatedUnion("type", [ChatInputResponseSchema, ChatOptOutSchema, ChatClientMetricSchema]);
export type ParsedChatClientMessage = z.infer<typeof ChatClientMessageSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Server → client (§3.3). Strict: every id the protocol requires is present, and nothing undocumented is sent.

/** protocol.md §7: outbound message text is at most 2,000 characters. */
export const MAX_MESSAGE_TEXT_CHARS = 2000;

export const ChatMessageSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.MESSAGE),
  id: z.string().regex(/^m_[A-Za-z0-9_-]+$/),
  role: z.enum(Role),
  text: z.string().max(MAX_MESSAGE_TEXT_CHARS),
  requestId: id.optional(),
});

export const ChatInputRequestSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.INPUT_REQUEST),
  id: z.string().regex(/^req_[A-Za-z0-9:]+_\d+$/),
  field: z.string().min(1),
  kind: z.enum(InputKind),
  label: z.string().min(1),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  pattern: z.string().optional(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string().optional() })).optional(),
  accept: z.string().optional(),
  multiple: z.boolean().optional(),
});

export const ChatInputErrorSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.INPUT_ERROR),
  id: z.string().regex(/^err_.+_\d+$/),
  requestId: id,
  message: z.string().optional(),
});

export const ChatInputCancelSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.INPUT_CANCEL),
  id: z.string().regex(/^cancel_.+$/),
  requestId: id,
  reason: z.string().optional(),
});

/** The record payload itself is checked against shared/record.schema.json (P2-T07), not here. */
export const ChatRecordSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.RECORD),
  id: z.string().regex(/^rec_\d+$/),
  record: z.record(z.string(), z.unknown()),
});

export const ChatTranscriptSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.TRANSCRIPT),
  id: z.string().regex(/^t[ua]_[A-Za-z0-9_-]+_\d+$/),
  role: z.enum(Role),
  text: z.string(),
  final: z.literal(true),
});

export const ChatSessionStateSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.SESSION_STATE),
  id: z.string().regex(/^state_\d+$/),
  status: z.enum(["active", "finalized", "closed"]),
  callActive: z.boolean(),
  outcome: z.enum(Outcome).nullable(),
  revision: z.number().int().min(1).nullable(),
  voiceAvailable: z.boolean(),
  notice: z.string().nullable(),
});

export const ChatSyncDoneSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.SYNC_DONE),
  id: z.string().regex(/^sync_\d+$/),
  lastSeq: z.number().int().min(0),
});

export const ChatClosingSchema = z.strictObject({
  type: z.literal(ChatServerMessageType.CLOSING),
  code: z.number().int().min(1000).max(4999),
  reason: z.string().max(123),
});

export const ChatServerMessageSchema = z.discriminatedUnion("type", [
  ChatMessageSchema,
  ChatInputRequestSchema,
  ChatInputErrorSchema,
  ChatInputCancelSchema,
  ChatRecordSchema,
  ChatTranscriptSchema,
  ChatSessionStateSchema,
  ChatSyncDoneSchema,
  ChatClosingSchema,
]);
