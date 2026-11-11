"""The outcome state machine (D16 rev 2, P2-T06). Pure and deterministic: given what the session holds and the event
that triggered finalization, decide the outcome. Precedence: optedOut > needsReview > completed > partial."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from app.protocol.enums import Outcome

from .conflicts import ResolvedField
from .fields import MAX_ATTEMPTS, REQUIRED_RECORD_FIELDS

ReviewRule = Literal["R-1", "R-2", "R-3", "R-4", "R-5"]


@dataclass(frozen=True, slots=True)
class ReviewFlag:
    """Why a human must look at the claim (D16):
    R-1 safety hazard flagged; R-2 identifier conflict unresolved; R-3 required field invalid after 3 attempts;
    R-4 vision check flagged a file (bonus); R-5 the agent called flag_for_review, or the record failed its schema."""

    rule: ReviewRule
    reason: str


# The triggers that run finalization (D16); nothing else does.
FinalizeTrigger = Literal["confirmSubmit", "optOutConfirmed", "idleTimeout", "testFinalize"]


@dataclass(frozen=True, slots=True)
class OutcomeFacts:
    fields: Mapping[str, ResolvedField]
    # Invalid answers per field (input_requests.attempts).
    attempts: Mapping[str, int] = field(default_factory=dict)
    # The user tapped Yes on the "Submit claim?" card since the session was last (re)opened.
    submit_confirmed: bool = False
    # Flags stored on the session (R-1, R-4, R-5). R-2 and R-3 are derived here from the fields.
    stored_flags: Sequence[ReviewFlag] = ()


@dataclass(frozen=True, slots=True)
class OutcomeDecision:
    """`finalize` True: `outcome`, `reason`, `review_flags`, `missing_required` are set.
    `finalize` False: not finalizable as asked (e.g. a submit confirmation while a required field is still missing);
    only `reason` is set."""

    finalize: bool
    reason: str
    outcome: Outcome | None = None
    review_flags: tuple[ReviewFlag, ...] = ()
    missing_required: tuple[str, ...] = ()


def missing_required(fields: Mapping[str, ResolvedField]) -> list[str]:
    """Required fields that are not valid, in catalog order."""
    return [i for i in REQUIRED_RECORD_FIELDS if fields[i].status != "valid"]


def review_flags(facts: OutcomeFacts) -> list[ReviewFlag]:
    """Every review flag that applies: the stored ones, plus R-2 and R-3 derived from the fields. Deduplicated, sorted."""
    flags = list(facts.stored_flags)
    for field_id in REQUIRED_RECORD_FIELDS:
        resolved = facts.fields[field_id]
        if resolved.conflict is not None and resolved.conflict.unresolved:
            flags.append(
                ReviewFlag("R-2", f"{field_id}: spoken and typed values differ and the user confirmed the spoken one")
            )
        # "unverified" counts too: a serial number said on the call and then typed wrongly 3 times is just as stuck
        # (the controller has stopped asking, D14), and the spoken value must never stand in for the typed one.
        if resolved.status in ("invalid", "unverified") and facts.attempts.get(field_id, 0) >= MAX_ATTEMPTS:
            flags.append(ReviewFlag("R-3", f"{field_id}: still {resolved.status} after {MAX_ATTEMPTS} attempts"))
    unique = {f"{flag.rule}\u0000{flag.reason}": flag for flag in flags}
    return sorted(unique.values(), key=lambda f: (f.rule, f.reason.encode("utf-16-be", "surrogatepass")))


def _describe_missing(fields: Mapping[str, ResolvedField], ids: Sequence[str]) -> str:
    return ", ".join(i if fields[i].status == "missing" else f"{i} ({fields[i].status})" for i in ids)


def decide_outcome(facts: OutcomeFacts, trigger: FinalizeTrigger, *, auto_complete_on_idle: bool) -> OutcomeDecision:
    """`auto_complete_on_idle`: AUTO_COMPLETE_ON_IDLE (D16, signed off as true): all-valid but unconfirmed at idle ->
    completed."""
    flags = tuple(review_flags(facts))
    missing = tuple(missing_required(facts.fields))

    def result(outcome: Outcome, reason: str) -> OutcomeDecision:
        return OutcomeDecision(True, reason, outcome, flags, missing)

    # An explicit, confirmed stop always wins, whatever else is true; review rules don't apply after an opt-out.
    if trigger == "optOutConfirmed":
        return result(Outcome.OPTED_OUT, "user asked to stop and confirmed; fields collected so far are included")

    if trigger == "confirmSubmit" and missing:
        # The confirm card is only offered when every required field is valid (D16), so this is a caller bug or a race.
        return OutcomeDecision(
            False, f"cannot confirm submission: required fields not valid: {_describe_missing(facts.fields, missing)}"
        )

    if flags:
        return result(Outcome.NEEDS_REVIEW, f"needs review: {'; '.join(f'{f.rule} {f.reason}' for f in flags)}")

    if trigger == "confirmSubmit":
        return result(Outcome.COMPLETED, "all required fields valid; user confirmed submission")

    # idleTimeout, or the token-gated testFinalize, which is evaluated the same way.
    cause = "idle timeout" if trigger == "idleTimeout" else "test finalization"
    if missing:
        return result(
            Outcome.PARTIAL, f"{cause} with required fields missing: {_describe_missing(facts.fields, missing)}"
        )
    if facts.submit_confirmed:
        return result(Outcome.COMPLETED, "all required fields valid; user confirmed submission")
    if auto_complete_on_idle:
        return result(Outcome.COMPLETED, "auto-finalized after inactivity; not explicitly confirmed")
    return result(Outcome.PARTIAL, f"{cause}: all required fields valid but not confirmed")


# ---------------------------------------------------------------------------------------------------------------------
# Reopening (D16 "after an outcome", PD3a)


@dataclass(frozen=True, slots=True)
class Lifecycle:
    status: Literal["active", "finalized", "closed"]
    outcome: Outcome | None


# What the user did. A socket reconnect is not user activity and never reopens anything.
Activity = Literal["chatInput", "callStarted", "callback", "reconnect", "resumeConfirmed"]


@dataclass(frozen=True, slots=True)
class ReopenDecision:
    """`reason` (when not reopening): notFinalized | closed | notUserActivity | resumeConfirmationRequired."""

    reopen: bool
    reason: str | None = None


def can_reopen(lifecycle: Lifecycle, activity: Activity) -> ReopenDecision:
    status, outcome = lifecycle.status, lifecycle.outcome
    if status == "closed":
        return ReopenDecision(False, "closed")  # 7 days after last activity: read-only forever
    if status == "active":
        return ReopenDecision(False, "notFinalized")
    if activity == "reconnect":
        return ReopenDecision(False, "notUserActivity")
    # After an opt-out the user first gets "Resume your claim?"; only Yes reopens (No keeps optedOut, no new revision).
    if outcome == Outcome.OPTED_OUT and activity != "resumeConfirmed":
        return ReopenDecision(False, "resumeConfirmationRequired")
    return ReopenDecision(True)
