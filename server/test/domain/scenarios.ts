// End-to-end domain scenarios for the golden records: real validators → candidate history → resolver → outcome →
// record. Every input is fixed (explicit seq and times), so the output is byte-for-byte reproducible.
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import type { Outcome } from "@device-repair/shared/protocol";
import { type Candidate, resolveField } from "../../src/domain/conflicts.js";
import { decideOutcome, type FinalizeTrigger, type ReviewFlag } from "../../src/domain/outcome.js";
import type { RecordInput } from "../../src/domain/record.js";
import { validateEmail, validateServiceCentre, validateSerialNumber } from "../../src/domain/validators/chatFields.js";
import type { ValidationResult } from "../../src/domain/validators/result.js";
import {
  validateDeviceModel,
  validateDeviceType,
  validateProblemDescription,
  validateProblemStartedAt,
  validateUrgency,
} from "../../src/domain/validators/voiceFields.js";

export const TODAY = "2026-11-10";
export const SIGNER = (fileId: string) => `https://repair.example.com/files/${fileId}?exp=1762800000&sig=TESTSIGNATURE`;
const SESSION_ID = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b";

class History {
  #seq = 0;
  readonly byField = new Map<RecordFieldId, Candidate[]>();

  /** Records one answer as the controller would: the validator's verdict, with chatOnly call values kept unverified. */
  add(field: RecordFieldId, source: "call" | "chat", result: ValidationResult<unknown>, userConfirmed = false): this {
    this.#seq += 1;
    const chatOnlyHeard = source === "call" && (field === "serialNumber" || field === "email") && result.status === "valid";
    const candidate: Candidate = {
      source,
      seq: this.#seq,
      collectedAt: new Date(Date.UTC(2026, 10, 10, 4, 30, 0) + this.#seq * 20_000).toISOString(),
      status: chatOnlyHeard ? "unverified" : result.status,
      normalized: result.status === "valid" ? result.normalized : null,
      userConfirmed,
    };
    this.byField.set(field, [...(this.byField.get(field) ?? []), candidate]);
    return this;
  }

  resolve() {
    return Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, resolveField(id, this.byField.get(id) ?? [])])) as RecordInput["fields"];
  }
}

const file = (fileId: string, mime: string, size: number, hexChar: string): ValidationResult<unknown> => ({
  status: "valid",
  normalized: { fileId, mime, size, sha256: hexChar.repeat(64) },
});

/** The voice part every scenario shares: what the user said on the call. */
function callAnswers(history: History): History {
  return history
    .add("deviceType", "call", validateDeviceType("my phone"))
    .add("deviceModel", "call", validateDeviceModel("iPhone 14 Pro"))
    .add("problemDescription", "call", validateProblemDescription("the screen flickers and goes black after a minute, it started after I dropped it"))
    .add("problemStartedAt", "call", validateProblemStartedAt("last Tuesday", { today: TODAY }))
    .add("urgency", "call", validateUrgency("I need it for work tomorrow"));
}

function input(history: History, trigger: FinalizeTrigger, extra: { storedFlags?: ReviewFlag[]; attempts?: Partial<Record<RecordFieldId, number>>; submitConfirmedAt?: string | null; previousRevision?: { revision: number; outcome: Outcome } | null; revision?: number } = {}): RecordInput {
  const fields = history.resolve();
  const decision = decideOutcome(
    { fields, attempts: extra.attempts ?? {}, submitConfirmed: Boolean(extra.submitConfirmedAt), storedFlags: extra.storedFlags ?? [] },
    trigger,
    { autoCompleteOnIdle: true },
  );
  if (!decision.finalize) throw new Error(decision.reason);
  return {
    sessionId: SESSION_ID,
    revision: extra.revision ?? 1,
    previousRevision: extra.previousRevision ?? null,
    outcome: decision.outcome,
    outcomeReason: decision.reason,
    reviewFlags: decision.reviewFlags,
    missingRequired: decision.missingRequired,
    fields,
    submitConfirmedAt: extra.submitConfirmedAt ?? null,
    engagement: { calls: 1, callSeconds: 212, chatMessages: 9, chatInputsSubmitted: 6, invalidAttempts: 1 },
    cost: { costUsd: 0.0123, costBreakdownUsd: { stt: 0.004, llm: 0.0021, tts: 0.0062, vision: 0 }, actualSpendUsd: 0 },
    endedAt: new Date("2026-11-10T04:46:40Z"),
    now: new Date("2026-11-10T04:46:41Z"),
    signFileUrl: SIGNER,
  };
}

export const SCENARIOS: Record<"completed" | "partial" | "optedOut" | "needsReview", () => RecordInput> = {
  /** Everything collected; the email heard on the call matches the typed one; the user confirmed. Revision 2. */
  completed: () => {
    const history = callAnswers(new History())
      .add("email", "call", validateEmail("asha.rao@example.com"))
      .add("serialNumber", "chat", validateSerialNumber("35 209900 176148"))
      .add("serialNumber", "chat", validateSerialNumber("35 209900 176148 1"))
      .add("purchaseInvoice", "chat", file("fInvoice7Kq2Lm9x", "application/pdf", 182233, "c"))
      .add("serviceCentre", "chat", validateServiceCentre("blr-koramangala"))
      .add("email", "chat", validateEmail("Asha.Rao@Example.com"))
      .add("additionalPhotos", "chat", { status: "skipped" })
      .add("additionalNotes", "chat", { status: "valid", normalized: "Please call before visiting." });
    return input(history, "confirmSubmit", { submitConfirmedAt: "2026-11-10T04:46:30Z", revision: 2, previousRevision: { revision: 1, outcome: "partial" as Outcome } });
  },
  /** The user left after the call: no invoice; the email was only said aloud; the idle timer fired. */
  partial: () => {
    const history = callAnswers(new History())
      .add("email", "call", validateEmail("asha.rao@example.com"))
      .add("serialNumber", "chat", validateSerialNumber("352099001761481"))
      .add("serviceCentre", "chat", validateServiceCentre("mum-dadar"));
    return input(history, "idleTimeout");
  },
  /** The user asked to stop on the call and confirmed. */
  optedOut: () => {
    const history = new History()
      .add("deviceType", "call", validateDeviceType("laptop"))
      .add("deviceModel", "call", validateDeviceModel("Dell XPS 13"))
      .add("problemDescription", "call", validateProblemDescription("it's broken"));
    return input(history, "optOutConfirmed");
  },
  /**
   * Swollen battery reported (R-1), the typed IMEI differs from the one the user read back and confirmed on the call
   * (R-2), and the urgency typed in chat differs from the spoken one (narrative: kept as an addendum).
   */
  needsReview: () => {
    const history = callAnswers(new History())
      .add("serialNumber", "call", validateSerialNumber("490154203237518"), true)
      .add("serialNumber", "chat", validateSerialNumber("352099001761481"))
      .add("urgency", "chat", validateUrgency("normal"))
      .add("purchaseInvoice", "chat", file("fInvoice7Kq2Lm9x", "image/jpeg", 98211, "d"))
      .add("additionalPhotos", "chat", { status: "valid", normalized: [{ fileId: "fPhotoAa11Bb22", mime: "image/png", size: 51200, sha256: "e".repeat(64) }] })
      .add("serviceCentre", "chat", validateServiceCentre("del-saket"))
      .add("email", "chat", validateEmail("asha+claims@example.co.in"))
      .add("additionalNotes", "chat", { status: "skipped" });
    return input(history, "confirmSubmit", {
      submitConfirmedAt: "2026-11-10T04:46:30Z",
      storedFlags: [{ rule: "R-1", reason: "safety: user reports the battery is swelling" }],
    });
  },
};
