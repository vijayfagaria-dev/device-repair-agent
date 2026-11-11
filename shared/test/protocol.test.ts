// The starter UI's wire contract (protocol.md §9): these values must not change, or the copied UI breaks.
import { describe, expect, it } from "vitest";
import {
  CallServerMessageType,
  ChatClientMessageType,
  ChatServerMessageType,
  DEFAULT_PLAYBACK_RATE,
  FieldSource,
  FieldStatus,
  InputKind,
  MIC_FRAME_BYTES,
  MIC_FRAME_MS,
  MIC_SAMPLE_RATE,
  Outcome,
  Role,
} from "../protocol/index.js";

describe("starter wire contract", () => {
  it("keeps the audio framing: 20 ms PCM16 mono frames at 16 kHz up, 24 kHz playback down", () => {
    expect(MIC_SAMPLE_RATE).toBe(16000);
    expect(MIC_FRAME_MS).toBe(20);
    expect(MIC_FRAME_BYTES).toBe(640);
    expect(DEFAULT_PLAYBACK_RATE).toBe(24000);
  });

  it("keeps the message type strings", () => {
    expect(Object.values(CallServerMessageType)).toEqual(["audio", "stopPlayback", "transcript", "closing"]);
    // The starter's values, unchanged and first; protocol.md §3.3/§3.4 (P3-T04) adds the rest (additive).
    expect(Object.values(ChatServerMessageType)).toEqual([
      "message",
      "inputRequest",
      "inputError",
      "inputCancel",
      "record",
      "transcript",
      "sessionState",
      "syncDone",
      "closing",
    ]);
    expect(Object.values(ChatClientMessageType)).toEqual(["inputResponse", "optOut", "clientMetric"]);
  });

  it("keeps the enum values used in records and input cards", () => {
    expect(Object.values(Role)).toEqual(["user", "agent"]);
    expect(Object.values(InputKind)).toEqual([
      "text",
      "email",
      "phone",
      "number",
      "date",
      "select",
      "multiSelect",
      "file",
      "confirm",
    ]);
    expect(Object.values(Outcome)).toEqual(["completed", "partial", "optedOut", "needsReview"]);
    expect(Object.values(FieldSource)).toEqual(["call", "chat"]);
    // The starter's three values, unchanged and first; P2-T07 adds skipped and unverified (protocol.md §9, additive).
    expect(Object.values(FieldStatus)).toEqual(["valid", "missing", "invalid", "skipped", "unverified"]);
  });
});
