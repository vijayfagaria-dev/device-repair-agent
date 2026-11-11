// The outcome state machine (P2-T06, D16): one test per decision-table row, the review rules, a property test, reopen.
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { Outcome } from "@device-repair/shared/protocol";
import { describe, expect, it } from "vitest";
import type { ResolvedField } from "../../src/domain/conflicts.js";
import {
  type Activity,
  canReopen,
  decideOutcome,
  type FinalizeTrigger,
  type Lifecycle,
  type OutcomeFacts,
  type ReopenDecision,
  type ReviewFlag,
  reviewFlags,
} from "../../src/domain/outcome.js";
import { REQUIRED_RECORD_FIELDS } from "../../src/domain/fields.js";
import { allValid, prng, resolved } from "./helpers.js";

const facts = (overrides: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  fields: allValid(),
  attempts: {},
  submitConfirmed: false,
  storedFlags: [],
  ...overrides,
});
const AUTO = { autoCompleteOnIdle: true };
const NO_AUTO = { autoCompleteOnIdle: false };
const SAFETY: ReviewFlag = { rule: "R-1", reason: "battery swelling reported" };

describe("D16 decision table", () => {
  it("optOutConfirmed → optedOut, always (even with review flags or missing fields)", () => {
    const decision = decideOutcome(facts({ fields: allValid({ email: resolved("missing") }), storedFlags: [SAFETY] }), "optOutConfirmed", AUTO);
    expect(decision).toMatchObject({ finalize: true, outcome: Outcome.OPTED_OUT, missingRequired: ["email"], reviewFlags: [SAFETY] });
  });

  it("confirmSubmit + any review rule → needsReview", () => {
    expect(decideOutcome(facts({ storedFlags: [SAFETY] }), "confirmSubmit", AUTO)).toMatchObject({
      outcome: Outcome.NEEDS_REVIEW,
      reason: "needs review: R-1 battery swelling reported",
    });
  });

  it("confirmSubmit + all required valid → completed", () => {
    expect(decideOutcome(facts(), "confirmSubmit", NO_AUTO)).toEqual({
      finalize: true,
      outcome: Outcome.COMPLETED,
      reason: "all required fields valid; user confirmed submission",
      reviewFlags: [],
      missingRequired: [],
    });
  });

  it("confirmSubmit + a required field not valid → not finalized (the card is only offered when all are valid)", () => {
    expect(decideOutcome(facts({ fields: allValid({ purchaseInvoice: resolved("missing"), email: resolved("unverified", "a@b.co", "call") }) }), "confirmSubmit", AUTO)).toEqual({
      finalize: false,
      reason: "cannot confirm submission: required fields not valid: purchaseInvoice, email (unverified)",
    });
  });

  it("idleTimeout + any review rule → needsReview (even with required fields missing)", () => {
    expect(decideOutcome(facts({ fields: allValid({ email: resolved("missing") }), storedFlags: [SAFETY] }), "idleTimeout", AUTO)).toMatchObject({
      outcome: Outcome.NEEDS_REVIEW,
    });
  });

  it("idleTimeout + all valid + no confirmation + auto-complete on → completed, flagged as unconfirmed", () => {
    expect(decideOutcome(facts(), "idleTimeout", AUTO)).toMatchObject({
      outcome: Outcome.COMPLETED,
      reason: "auto-finalized after inactivity; not explicitly confirmed",
    });
  });

  it("idleTimeout + all valid + no confirmation + auto-complete off → partial, not confirmed", () => {
    expect(decideOutcome(facts(), "idleTimeout", NO_AUTO)).toMatchObject({
      outcome: Outcome.PARTIAL,
      reason: "idle timeout: all required fields valid but not confirmed",
    });
  });

  it("idleTimeout + a required field missing or unverified → partial, naming them", () => {
    const decision = decideOutcome(facts({ fields: allValid({ purchaseInvoice: resolved("missing"), serialNumber: resolved("unverified", { kind: "imei", value: "352099001761481" }, "call") }) }), "idleTimeout", AUTO);
    expect(decision).toMatchObject({
      outcome: Outcome.PARTIAL,
      reason: "idle timeout with required fields missing: serialNumber (unverified), purchaseInvoice",
      missingRequired: ["serialNumber", "purchaseInvoice"],
    });
    // The brief's example wording.
    expect(decideOutcome(facts({ fields: allValid({ purchaseInvoice: resolved("missing") }) }), "idleTimeout", AUTO)).toMatchObject({
      reason: "idle timeout with required fields missing: purchaseInvoice",
    });
  });

  it("idleTimeout after an explicit confirmation → completed as confirmed", () => {
    expect(decideOutcome(facts({ submitConfirmed: true }), "idleTimeout", NO_AUTO)).toMatchObject({ outcome: Outcome.COMPLETED, reason: "all required fields valid; user confirmed submission" });
  });

  it("testFinalize is evaluated like the idle timeout", () => {
    expect(decideOutcome(facts({ fields: allValid({ email: resolved("missing") }) }), "testFinalize", AUTO)).toMatchObject({
      outcome: Outcome.PARTIAL,
      reason: "test finalization with required fields missing: email",
    });
    expect(decideOutcome(facts(), "testFinalize", AUTO).finalize).toBe(true);
  });

  it("optional fields never affect the outcome", () => {
    const optionalGone = allValid({ additionalPhotos: resolved("missing"), additionalNotes: resolved("skipped", null, "chat") });
    expect(decideOutcome(facts({ fields: optionalGone }), "confirmSubmit", AUTO)).toMatchObject({ outcome: Outcome.COMPLETED, missingRequired: [] });
  });
});

describe("review rules", () => {
  it("R-2: an unresolved identifier conflict", () => {
    const serial: ResolvedField = {
      ...resolved("valid", { kind: "imei", value: "352099001761481" }, "chat"),
      conflict: { field: "serialNumber", callValue: {}, chatValue: {}, resolution: "chatValue", reason: "x", unresolved: true },
    };
    expect(reviewFlags(facts({ fields: allValid({ serialNumber: serial }) }))).toEqual([
      { rule: "R-2", reason: "serialNumber: spoken and typed values differ and the user confirmed the spoken one" },
    ]);
    expect(decideOutcome(facts({ fields: allValid({ serialNumber: serial }) }), "confirmSubmit", AUTO)).toMatchObject({ outcome: Outcome.NEEDS_REVIEW });
  });

  it("R-3: a required field still invalid after 3 attempts (but never-provided or fewer attempts → partial)", () => {
    const invalidEmail = allValid({ email: resolved("invalid", null, "chat") });
    expect(decideOutcome(facts({ fields: invalidEmail, attempts: { email: 3 } }), "idleTimeout", AUTO)).toMatchObject({
      outcome: Outcome.NEEDS_REVIEW,
      reviewFlags: [{ rule: "R-3", reason: "email: still invalid after 3 attempts" }],
    });
    expect(decideOutcome(facts({ fields: invalidEmail, attempts: { email: 2 } }), "idleTimeout", AUTO)).toMatchObject({ outcome: Outcome.PARTIAL });
    // P2 audit: a serial said on the call (unverified), then typed wrongly 3 times, is stuck the same way.
    const spokenSerial = allValid({ serialNumber: resolved("unverified", { kind: "imei", value: "352099001761481" }, "call") });
    expect(decideOutcome(facts({ fields: spokenSerial, attempts: { serialNumber: 3 } }), "idleTimeout", AUTO)).toMatchObject({
      outcome: Outcome.NEEDS_REVIEW,
      reviewFlags: [{ rule: "R-3", reason: "serialNumber: still unverified after 3 attempts" }],
    });
    expect(decideOutcome(facts({ fields: spokenSerial, attempts: { serialNumber: 1 } }), "idleTimeout", AUTO)).toMatchObject({ outcome: Outcome.PARTIAL });
    // An invalid optional field never triggers R-3.
    expect(reviewFlags(facts({ fields: allValid({ additionalNotes: resolved("invalid", null, "chat") }), attempts: { additionalNotes: 5 } }))).toEqual([]);
  });

  it("R-1, R-4 and R-5 come from stored flags; flags are deduplicated and sorted by rule", () => {
    const stored: ReviewFlag[] = [
      { rule: "R-5", reason: "agent: user disputes the warranty" },
      { rule: "R-4", reason: "invoice image does not look like an invoice" },
      SAFETY,
      SAFETY,
    ];
    expect(reviewFlags(facts({ storedFlags: stored })).map((f) => f.rule)).toEqual(["R-1", "R-4", "R-5"]);
  });
});

describe("property: completed implies a fully valid, confirmed (or auto-completed), unflagged claim", () => {
  it("holds for 2,000 random sessions", () => {
    const random = prng(20261108);
    const statuses: ResolvedField["status"][] = ["valid", "valid", "valid", "invalid", "missing", "unverified", "skipped"];
    const triggers: FinalizeTrigger[] = ["confirmSubmit", "optOutConfirmed", "idleTimeout", "testFinalize"];
    const flagPool: ReviewFlag[] = [SAFETY, { rule: "R-4", reason: "vision" }, { rule: "R-5", reason: "agent" }];
    let completed = 0;
    for (let i = 0; i < 2000; i++) {
      const fields = Object.fromEntries(
        RECORD_FIELD_IDS.map((id) => [id, random.chance(0.75) ? resolved("valid", "x", "chat") : resolved(random.pick(statuses), "x", "call")]),
      ) as Record<RecordFieldId, ResolvedField>;
      const attempts = Object.fromEntries(RECORD_FIELD_IDS.map((id) => [id, random.int(5)]));
      const f: OutcomeFacts = { fields, attempts, submitConfirmed: random.chance(0.3), storedFlags: random.chance(0.15) ? [random.pick(flagPool)] : [] };
      const trigger = random.pick(triggers);
      const options = { autoCompleteOnIdle: random.chance(0.5) };
      const decision = decideOutcome(f, trigger, options);
      if (!decision.finalize) {
        expect(trigger).toBe("confirmSubmit");
        expect(REQUIRED_RECORD_FIELDS.some((id) => fields[id].status !== "valid")).toBe(true);
        continue;
      }
      if (decision.outcome === Outcome.COMPLETED) {
        completed += 1;
        expect(REQUIRED_RECORD_FIELDS.every((id) => fields[id].status === "valid")).toBe(true);
        expect(trigger === "confirmSubmit" || f.submitConfirmed || ((trigger === "idleTimeout" || trigger === "testFinalize") && options.autoCompleteOnIdle)).toBe(true);
        expect(decision.reviewFlags).toEqual([]);
        expect(decision.missingRequired).toEqual([]);
      }
      if (trigger === "optOutConfirmed") expect(decision.outcome).toBe(Outcome.OPTED_OUT);
      if (decision.outcome === Outcome.PARTIAL) expect(decision.reviewFlags).toEqual([]);
      if (decision.reviewFlags.length > 0 && trigger !== "optOutConfirmed") expect(decision.outcome).toBe(Outcome.NEEDS_REVIEW);
    }
    expect(completed).toBeGreaterThan(50); // the generator does reach the interesting case
  });
});

describe("canReopen", () => {
  const cases: [Lifecycle, Activity, ReopenDecision][] = [
    [{ status: "finalized", outcome: Outcome.PARTIAL }, "chatInput", { reopen: true }],
    [{ status: "finalized", outcome: Outcome.COMPLETED }, "callStarted", { reopen: true }],
    [{ status: "finalized", outcome: Outcome.NEEDS_REVIEW }, "callback", { reopen: true }],
    [{ status: "finalized", outcome: Outcome.PARTIAL }, "reconnect", { reopen: false, reason: "notUserActivity" }],
    [{ status: "finalized", outcome: Outcome.OPTED_OUT }, "chatInput", { reopen: false, reason: "resumeConfirmationRequired" }],
    [{ status: "finalized", outcome: Outcome.OPTED_OUT }, "callStarted", { reopen: false, reason: "resumeConfirmationRequired" }],
    [{ status: "finalized", outcome: Outcome.OPTED_OUT }, "resumeConfirmed", { reopen: true }],
    [{ status: "closed", outcome: Outcome.PARTIAL }, "chatInput", { reopen: false, reason: "closed" }],
    [{ status: "closed", outcome: Outcome.OPTED_OUT }, "resumeConfirmed", { reopen: false, reason: "closed" }],
    [{ status: "active", outcome: null }, "chatInput", { reopen: false, reason: "notFinalized" }],
  ];
  it.each(cases)("%j + %s → %j", (lifecycle, activity, expected) => {
    expect(canReopen(lifecycle, activity)).toEqual(expected);
  });
});
