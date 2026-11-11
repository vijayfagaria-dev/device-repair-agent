// The outcome state machine (D16 rev 2, P2-T06). Pure and deterministic: given what the session holds and the event
// that triggered finalization, decide the outcome. Precedence: optedOut > needsReview > completed > partial.
import type { RecordFieldId } from "@device-repair/shared/fields";
import { Outcome } from "@device-repair/shared/protocol";
import type { ResolvedField } from "./conflicts.js";
import { MAX_ATTEMPTS, REQUIRED_RECORD_FIELDS } from "./fields.js";

export type ReviewRule = "R-1" | "R-2" | "R-3" | "R-4" | "R-5";

/**
 * Why a human must look at the claim (D16):
 * R-1 safety hazard flagged · R-2 identifier conflict unresolved · R-3 required field invalid after 3 attempts ·
 * R-4 vision check flagged a file (bonus) · R-5 the agent called flag_for_review, or the record failed its schema.
 */
export interface ReviewFlag {
  rule: ReviewRule;
  reason: string;
}

/** The triggers that run finalization (D16); nothing else does. */
export type FinalizeTrigger = "confirmSubmit" | "optOutConfirmed" | "idleTimeout" | "testFinalize";

export interface OutcomeFacts {
  fields: Readonly<Record<RecordFieldId, ResolvedField>>;
  /** Invalid answers per field (input_requests.attempts). */
  attempts: Readonly<Partial<Record<RecordFieldId, number>>>;
  /** The user tapped Yes on the "Submit claim?" card since the session was last (re)opened. */
  submitConfirmed: boolean;
  /** Flags stored on the session (R-1, R-4, R-5). R-2 and R-3 are derived here from the fields. */
  storedFlags: readonly ReviewFlag[];
}

export interface OutcomeOptions {
  /** AUTO_COMPLETE_ON_IDLE (D16, signed off as true): all-valid but unconfirmed at idle → completed. */
  autoCompleteOnIdle: boolean;
}

export type OutcomeDecision =
  | {
      finalize: true;
      outcome: Outcome;
      reason: string;
      reviewFlags: ReviewFlag[];
      missingRequired: RecordFieldId[];
    }
  | {
      /** Not finalizable as asked (e.g. a submit confirmation while a required field is still missing). */
      finalize: false;
      reason: string;
    };

/** Required fields that are not valid, in catalog order. */
export function missingRequired(fields: OutcomeFacts["fields"]): RecordFieldId[] {
  return REQUIRED_RECORD_FIELDS.filter((id) => fields[id].status !== "valid");
}

/** Every review flag that applies: the stored ones, plus R-2 and R-3 derived from the fields. Deduplicated, sorted. */
export function reviewFlags(facts: OutcomeFacts): ReviewFlag[] {
  const flags = [...facts.storedFlags];
  for (const id of REQUIRED_RECORD_FIELDS) {
    const field = facts.fields[id];
    if (field.conflict?.unresolved) flags.push({ rule: "R-2", reason: `${id}: spoken and typed values differ and the user confirmed the spoken one` });
    // "unverified" counts too: a serial number said on the call and then typed wrongly 3 times is just as stuck (the
    // controller has stopped asking, D14), and the spoken value must never stand in for the typed one.
    if ((field.status === "invalid" || field.status === "unverified") && (facts.attempts[id] ?? 0) >= MAX_ATTEMPTS) {
      flags.push({ rule: "R-3", reason: `${id}: still ${field.status} after ${MAX_ATTEMPTS} attempts` });
    }
  }
  const unique = new Map(flags.map((flag) => [`${flag.rule}\u0000${flag.reason}`, flag]));
  return [...unique.values()].sort((a, b) => (a.rule === b.rule ? (a.reason < b.reason ? -1 : 1) : a.rule < b.rule ? -1 : 1));
}

const describeMissing = (fields: OutcomeFacts["fields"], ids: readonly RecordFieldId[]) =>
  ids.map((id) => (fields[id].status === "missing" ? id : `${id} (${fields[id].status})`)).join(", ");

export function decideOutcome(facts: OutcomeFacts, trigger: FinalizeTrigger, { autoCompleteOnIdle }: OutcomeOptions): OutcomeDecision {
  const flags = reviewFlags(facts);
  const missing = missingRequired(facts.fields);
  const result = (outcome: Outcome, reason: string): OutcomeDecision => ({ finalize: true, outcome, reason, reviewFlags: flags, missingRequired: missing });

  // An explicit, confirmed stop always wins, whatever else is true; review rules don't apply after an opt-out.
  if (trigger === "optOutConfirmed") return result(Outcome.OPTED_OUT, "user asked to stop and confirmed; fields collected so far are included");

  if (trigger === "confirmSubmit" && missing.length > 0) {
    // The confirm card is only offered when every required field is valid (D16), so this is a caller bug or a race.
    return { finalize: false, reason: `cannot confirm submission: required fields not valid: ${describeMissing(facts.fields, missing)}` };
  }

  if (flags.length > 0) {
    return result(Outcome.NEEDS_REVIEW, `needs review: ${flags.map((flag) => `${flag.rule} ${flag.reason}`).join("; ")}`);
  }

  if (trigger === "confirmSubmit") return result(Outcome.COMPLETED, "all required fields valid; user confirmed submission");

  // idleTimeout, or the token-gated testFinalize, which is evaluated the same way.
  const cause = trigger === "idleTimeout" ? "idle timeout" : "test finalization";
  if (missing.length > 0) return result(Outcome.PARTIAL, `${cause} with required fields missing: ${describeMissing(facts.fields, missing)}`);
  if (facts.submitConfirmed) return result(Outcome.COMPLETED, "all required fields valid; user confirmed submission");
  if (autoCompleteOnIdle) return result(Outcome.COMPLETED, "auto-finalized after inactivity; not explicitly confirmed");
  return result(Outcome.PARTIAL, `${cause}: all required fields valid but not confirmed`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reopening (D16 "after an outcome", PD3a)

export interface Lifecycle {
  status: "active" | "finalized" | "closed";
  outcome: Outcome | null;
}

/** What the user did. A socket reconnect is not user activity and never reopens anything. */
export type Activity = "chatInput" | "callStarted" | "callback" | "reconnect" | "resumeConfirmed";

export type ReopenDecision =
  | { reopen: true }
  | { reopen: false; reason: "notFinalized" | "closed" | "notUserActivity" | "resumeConfirmationRequired" };

export function canReopen({ status, outcome }: Lifecycle, activity: Activity): ReopenDecision {
  if (status === "closed") return { reopen: false, reason: "closed" }; // 7 days after last activity: read-only forever
  if (status === "active") return { reopen: false, reason: "notFinalized" };
  if (activity === "reconnect") return { reopen: false, reason: "notUserActivity" };
  // After an opt-out the user first gets "Resume your claim?"; only Yes reopens (No keeps optedOut, no new revision).
  if (outcome === Outcome.OPTED_OUT && activity !== "resumeConfirmed") return { reopen: false, reason: "resumeConfirmationRequired" };
  return { reopen: true };
}
