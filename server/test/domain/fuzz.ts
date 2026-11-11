// Random record inputs for fuzz tests (P2-T07, P6-T02): random answers through the real validators, the resolver and
// the outcome machine. Reproducible from a seed.
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { type Candidate, resolveField } from "../../src/domain/conflicts.js";
import { decideOutcome, type FinalizeTrigger } from "../../src/domain/outcome.js";
import type { RecordInput } from "../../src/domain/record.js";
import {
  validateAdditionalNotes,
  validateEmail,
  validateServiceCentre,
  validateSerialNumber,
} from "../../src/domain/validators/chatFields.js";
import { validateUpload } from "../../src/domain/validators/files.js";
import type { ValidationResult } from "../../src/domain/validators/result.js";
import {
  validateDeviceModel,
  validateDeviceType,
  validateProblemDescription,
  validateProblemStartedAt,
  validateUrgency,
} from "../../src/domain/validators/voiceFields.js";
import type { prng } from "./helpers.js";
import { SIGNER, TODAY } from "./scenarios.js";

const CONTROL = ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u200B", "\u202E", "\uFEFF", "\r\n", "\t"];
const EXOTIC = ["é", "e\u0301", "😀", "👩🏽\u200D💻", "१२३", "１２３", "Ａ", "\"", "'", "<script>", "@", "-", ".", "/", "\\", "ß", "İ"];
// Bait for the sanitization oracle (P6-T02): things that must never reach a record outside what the user wrote.
const BAIT = ["/data/uploads/f1.pdf", "file:fAbc12345", "sk-abcdef123456", "chatcmpl-abcdef12", "req_01abcdefghij"];

export function junk(random: ReturnType<typeof prng>): string {
  const length = random.pick([0, 1, 3, 12, 60, 400, 1200]);
  let text = "";
  for (let i = 0; i < length; i++) {
    const roll = random.next();
    text += roll < 0.08 ? random.pick(CONTROL) : roll < 0.2 ? random.pick(EXOTIC) : roll < 0.23 ? ` ${random.pick(BAIT)} ` : String.fromCharCode(32 + random.int(95));
  }
  return text;
}

const SAMPLES: Record<string, readonly unknown[]> = {
  deviceType: ["phone", "my laptop", "galaxy watch", "a thing", "other", "AirPods", ""],
  deviceModel: ["iPhone 14 Pro", "Samsung", "I don't know", "Zorbo X1", { brand: "Dell", model: "XPS 13" }, "x".repeat(90)],
  problemDescription: ["the screen flickers and goes black", "it's broken", { summary: "S", verbatim: "battery drains very fast overnight" }],
  problemStartedAt: ["yesterday", "last Tuesday", "two weeks ago", "2026-10-01", "tomorrow", "I don't know", { spoken: "last month", date: "2020-01-01" }, "2049-01-01"],
  urgency: ["high", "no rush", "need it for work tomorrow", "hmm", { level: "critical", reason: "medical" }],
  serialNumber: ["352099001761481", "35209900176148", "C02XL0GHJG5H", "AAAAAAAA", "abc#123"],
  email: ["asha@example.com", "a@b", "user@bücher.de", "foo@@x.com", "  A@Example.COM "],
  serviceCentre: ["blr-koramangala", "del-saket", "forged", "Koramangala"],
  additionalNotes: ["note", null, "", "x".repeat(1001)],
};

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function randomFile(random: ReturnType<typeof prng>, field: "purchaseInvoice" | "additionalPhotos") {
  const bytes = Buffer.concat([random.pick([PDF, PNG]), Buffer.from(junk(random))]);
  const checked = validateUpload(field, { bytes, declaredType: random.pick([null, "image/png", "application/pdf"]) });
  if (checked.status !== "valid") return null;
  const { originalName: _name, ...stored } = checked.normalized;
  return { fileId: `f${random.int(1e9).toString(36).padStart(10, "0")}`, ...stored };
}

function randomAnswer(random: ReturnType<typeof prng>, field: RecordFieldId, source: "call" | "chat"): ValidationResult<unknown> {
  const raw = random.chance(0.35) ? junk(random) : random.pick(SAMPLES[field] ?? [null]);
  switch (field) {
    case "deviceType":
      return validateDeviceType(raw);
    case "deviceModel":
      return validateDeviceModel(raw, { allowUnknown: random.chance(0.5) });
    case "problemDescription":
      return validateProblemDescription(raw);
    case "problemStartedAt":
      return validateProblemStartedAt(raw, { today: TODAY });
    case "urgency":
      return validateUrgency(raw);
    case "serialNumber":
      return validateSerialNumber(raw);
    case "email":
      return validateEmail(raw);
    case "serviceCentre":
      return validateServiceCentre(raw, { spoken: source === "call" });
    case "additionalNotes":
      return validateAdditionalNotes(raw);
    case "purchaseInvoice": {
      const f = randomFile(random, field);
      return f ? { status: "valid", normalized: f } : { status: "invalid", error: "x" };
    }
    case "additionalPhotos": {
      if (random.chance(0.2)) return { status: "skipped" };
      const files = Array.from({ length: 1 + random.int(5) }, () => randomFile(random, field)).filter((f) => f !== null);
      return files.length > 0 ? { status: "valid", normalized: files } : { status: "invalid", error: "x" };
    }
  }
}

const TRIGGERS: FinalizeTrigger[] = ["confirmSubmit", "optOutConfirmed", "idleTimeout", "testFinalize"];

/** One random, finalizable record input. A refused submit confirmation falls back to the idle timer, as in production. */
export function randomRecordInput(random: ReturnType<typeof prng>): RecordInput {
  let seq = 0;
  const fields = Object.fromEntries(
    RECORD_FIELD_IDS.map((id) => {
      const history: Candidate[] = Array.from({ length: random.int(5) }, () => {
        const source = random.chance(0.5) ? "call" : "chat";
        const result = randomAnswer(random, id, source);
        seq += 1 + random.int(3);
        const heard = source === "call" && (id === "serialNumber" || id === "email") && result.status === "valid";
        return {
          source,
          seq,
          collectedAt: new Date(Date.UTC(2026, 10, 10, 4, 0, 0) + seq * 1000).toISOString(),
          status: heard ? "unverified" : result.status,
          normalized: result.status === "valid" ? result.normalized : null,
          userConfirmed: random.chance(0.1),
        } satisfies Candidate;
      });
      return [id, resolveField(id, history)];
    }),
  ) as RecordInput["fields"];
  const facts = {
    fields,
    attempts: Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, random.int(4)])),
    submitConfirmed: random.chance(0.3),
    storedFlags: random.chance(0.1) ? [{ rule: "R-1" as const, reason: junk(random) || "safety" }] : [],
  };
  const options = { autoCompleteOnIdle: random.chance(0.5) };
  const trigger = random.pick(TRIGGERS);
  let decision = decideOutcome(facts, trigger, options);
  if (!decision.finalize) {
    // Only a submit confirmation with a required field not valid is refused; that session ends on the idle timer.
    if (trigger !== "confirmSubmit" || !/^cannot confirm submission: required fields not valid: /.test(decision.reason)) {
      throw new Error(`unexpected refusal: ${decision.reason}`);
    }
    decision = decideOutcome(facts, "idleTimeout", options);
  }
  if (!decision.finalize) throw new Error("idle timeout always finalizes");
  const input: RecordInput = {
    sessionId: "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b",
    revision: 1 + random.int(3),
    previousRevision: null,
    outcome: decision.outcome,
    outcomeReason: decision.reason,
    reviewFlags: decision.reviewFlags,
    missingRequired: decision.missingRequired,
    fields,
    submitConfirmedAt: random.chance(0.5) ? "2026-11-10T04:46:30Z" : null,
    engagement: { calls: random.int(3), callSeconds: random.int(600), chatMessages: random.int(30), chatInputsSubmitted: random.int(12), invalidAttempts: random.int(6) },
    cost: { costUsd: random.next(), costBreakdownUsd: { stt: random.next(), llm: random.next(), tts: random.next(), vision: 0 }, actualSpendUsd: 0 },
    endedAt: new Date("2026-11-10T05:00:00Z"),
    now: new Date("2026-11-10T05:00:01Z"),
    signFileUrl: SIGNER,
  };
  return input;
}
