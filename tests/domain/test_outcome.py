# ruff: noqa: RUF012
"""The outcome state machine (P2-T06, D16): one test per decision-table row, the review rules, a property test,
reopen."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from app.domain.conflicts import FieldConflict
from app.domain.fields import RECORD_FIELD_IDS, REQUIRED_RECORD_FIELDS
from app.domain.outcome import (
    Lifecycle,
    OutcomeFacts,
    ReopenDecision,
    ReviewFlag,
    can_reopen,
    decide_outcome,
    review_flags,
)
from app.protocol import Outcome

from .helpers import all_valid, prng, resolved


def facts(**overrides: Any) -> OutcomeFacts:
    base = OutcomeFacts(fields=all_valid(), attempts={}, submit_confirmed=False, stored_flags=[])
    return replace(base, **overrides)


AUTO = True
NO_AUTO = False
SAFETY = ReviewFlag("R-1", "battery swelling reported")


class TestD16DecisionTable:
    def test_opt_out_confirmed_is_opted_out_always(self) -> None:
        decision = decide_outcome(
            facts(fields=all_valid({"email": resolved("missing")}), stored_flags=[SAFETY]),
            "optOutConfirmed",
            auto_complete_on_idle=AUTO,
        )
        assert decision.finalize
        assert decision.outcome == Outcome.OPTED_OUT
        assert decision.missing_required == ("email",)
        assert decision.review_flags == (SAFETY,)

    def test_confirm_submit_with_any_review_rule_is_needs_review(self) -> None:
        decision = decide_outcome(facts(stored_flags=[SAFETY]), "confirmSubmit", auto_complete_on_idle=AUTO)
        assert decision.outcome == Outcome.NEEDS_REVIEW
        assert decision.reason == "needs review: R-1 battery swelling reported"

    def test_confirm_submit_with_all_required_valid_is_completed(self) -> None:
        decision = decide_outcome(facts(), "confirmSubmit", auto_complete_on_idle=NO_AUTO)
        assert decision.finalize is True
        assert decision.outcome == Outcome.COMPLETED
        assert decision.reason == "all required fields valid; user confirmed submission"
        assert decision.review_flags == ()
        assert decision.missing_required == ()

    def test_confirm_submit_with_a_required_field_not_valid_is_not_finalized(self) -> None:
        fields = all_valid({"purchaseInvoice": resolved("missing"), "email": resolved("unverified", "a@b.co", "call")})
        decision = decide_outcome(facts(fields=fields), "confirmSubmit", auto_complete_on_idle=AUTO)
        assert decision.finalize is False
        assert decision.outcome is None
        assert (
            decision.reason
            == "cannot confirm submission: required fields not valid: purchaseInvoice, email (unverified)"
        )

    def test_idle_timeout_with_any_review_rule_is_needs_review_even_with_required_fields_missing(self) -> None:
        decision = decide_outcome(
            facts(fields=all_valid({"email": resolved("missing")}), stored_flags=[SAFETY]),
            "idleTimeout",
            auto_complete_on_idle=AUTO,
        )
        assert decision.outcome == Outcome.NEEDS_REVIEW

    def test_idle_timeout_all_valid_no_confirmation_auto_complete_on_is_completed_flagged_as_unconfirmed(self) -> None:
        decision = decide_outcome(facts(), "idleTimeout", auto_complete_on_idle=AUTO)
        assert decision.outcome == Outcome.COMPLETED
        assert decision.reason == "auto-finalized after inactivity; not explicitly confirmed"

    def test_idle_timeout_all_valid_no_confirmation_auto_complete_off_is_partial_not_confirmed(self) -> None:
        decision = decide_outcome(facts(), "idleTimeout", auto_complete_on_idle=NO_AUTO)
        assert decision.outcome == Outcome.PARTIAL
        assert decision.reason == "idle timeout: all required fields valid but not confirmed"

    def test_idle_timeout_with_a_required_field_missing_or_unverified_is_partial_naming_them(self) -> None:
        fields = all_valid(
            {
                "purchaseInvoice": resolved("missing"),
                "serialNumber": resolved("unverified", {"kind": "imei", "value": "352099001761481"}, "call"),
            }
        )
        decision = decide_outcome(facts(fields=fields), "idleTimeout", auto_complete_on_idle=AUTO)
        assert decision.outcome == Outcome.PARTIAL
        assert (
            decision.reason == "idle timeout with required fields missing: serialNumber (unverified), purchaseInvoice"
        )
        assert decision.missing_required == ("serialNumber", "purchaseInvoice")
        # The brief's example wording.
        brief = decide_outcome(
            facts(fields=all_valid({"purchaseInvoice": resolved("missing")})), "idleTimeout", auto_complete_on_idle=AUTO
        )
        assert brief.reason == "idle timeout with required fields missing: purchaseInvoice"

    def test_idle_timeout_after_an_explicit_confirmation_is_completed_as_confirmed(self) -> None:
        decision = decide_outcome(facts(submit_confirmed=True), "idleTimeout", auto_complete_on_idle=NO_AUTO)
        assert decision.outcome == Outcome.COMPLETED
        assert decision.reason == "all required fields valid; user confirmed submission"

    def test_test_finalize_is_evaluated_like_the_idle_timeout(self) -> None:
        decision = decide_outcome(
            facts(fields=all_valid({"email": resolved("missing")})), "testFinalize", auto_complete_on_idle=AUTO
        )
        assert decision.outcome == Outcome.PARTIAL
        assert decision.reason == "test finalization with required fields missing: email"
        assert decide_outcome(facts(), "testFinalize", auto_complete_on_idle=AUTO).finalize

    def test_optional_fields_never_affect_the_outcome(self) -> None:
        optional_gone = all_valid(
            {"additionalPhotos": resolved("missing"), "additionalNotes": resolved("skipped", None, "chat")}
        )
        decision = decide_outcome(facts(fields=optional_gone), "confirmSubmit", auto_complete_on_idle=AUTO)
        assert decision.outcome == Outcome.COMPLETED
        assert decision.missing_required == ()


class TestReviewRules:
    def test_r2_an_unresolved_identifier_conflict(self) -> None:
        serial = replace(
            resolved("valid", {"kind": "imei", "value": "352099001761481"}, "chat"),
            conflict=FieldConflict("serialNumber", {}, {}, "chatValue", "x", True),
        )
        assert review_flags(facts(fields=all_valid({"serialNumber": serial}))) == [
            ReviewFlag("R-2", "serialNumber: spoken and typed values differ and the user confirmed the spoken one")
        ]
        decision = decide_outcome(
            facts(fields=all_valid({"serialNumber": serial})), "confirmSubmit", auto_complete_on_idle=AUTO
        )
        assert decision.outcome == Outcome.NEEDS_REVIEW

    def test_r3_a_required_field_still_invalid_after_3_attempts(self) -> None:
        invalid_email = all_valid({"email": resolved("invalid", None, "chat")})
        decision = decide_outcome(
            facts(fields=invalid_email, attempts={"email": 3}), "idleTimeout", auto_complete_on_idle=AUTO
        )
        assert decision.outcome == Outcome.NEEDS_REVIEW
        assert decision.review_flags == (ReviewFlag("R-3", "email: still invalid after 3 attempts"),)
        fewer = decide_outcome(
            facts(fields=invalid_email, attempts={"email": 2}), "idleTimeout", auto_complete_on_idle=AUTO
        )
        assert fewer.outcome == Outcome.PARTIAL
        # P2 audit: a serial said on the call (unverified), then typed wrongly 3 times, is stuck the same way.
        spoken_serial = all_valid(
            {"serialNumber": resolved("unverified", {"kind": "imei", "value": "352099001761481"}, "call")}
        )
        stuck = decide_outcome(
            facts(fields=spoken_serial, attempts={"serialNumber": 3}), "idleTimeout", auto_complete_on_idle=AUTO
        )
        assert stuck.outcome == Outcome.NEEDS_REVIEW
        assert stuck.review_flags == (ReviewFlag("R-3", "serialNumber: still unverified after 3 attempts"),)
        once = decide_outcome(
            facts(fields=spoken_serial, attempts={"serialNumber": 1}), "idleTimeout", auto_complete_on_idle=AUTO
        )
        assert once.outcome == Outcome.PARTIAL
        # An invalid optional field never triggers R-3.
        optional = facts(
            fields=all_valid({"additionalNotes": resolved("invalid", None, "chat")}), attempts={"additionalNotes": 5}
        )
        assert review_flags(optional) == []

    def test_r1_r4_and_r5_come_from_stored_flags_deduplicated_and_sorted_by_rule(self) -> None:
        stored = [
            ReviewFlag("R-5", "agent: user disputes the warranty"),
            ReviewFlag("R-4", "invoice image does not look like an invoice"),
            SAFETY,
            SAFETY,
        ]
        assert [f.rule for f in review_flags(facts(stored_flags=stored))] == ["R-1", "R-4", "R-5"]

    def test_sorts_flags_with_the_same_rule_by_reason(self) -> None:
        stored = [ReviewFlag("R-5", "b"), ReviewFlag("R-5", "a")]
        assert [f.reason for f in review_flags(facts(stored_flags=stored))] == ["a", "b"]


def test_property_completed_implies_a_fully_valid_confirmed_or_auto_completed_unflagged_claim() -> None:
    """Holds for 2,000 random sessions."""
    random = prng(20261108)
    statuses = ["valid", "valid", "valid", "invalid", "missing", "unverified", "skipped"]
    triggers = ["confirmSubmit", "optOutConfirmed", "idleTimeout", "testFinalize"]
    flag_pool = [SAFETY, ReviewFlag("R-4", "vision"), ReviewFlag("R-5", "agent")]
    completed = 0
    for _ in range(2000):
        fields = {
            i: resolved("valid", "x", "chat") if random.chance(0.75) else resolved(random.pick(statuses), "x", "call")
            for i in RECORD_FIELD_IDS
        }
        attempts = {i: random.int(5) for i in RECORD_FIELD_IDS}
        f = OutcomeFacts(
            fields=fields,
            attempts=attempts,
            submit_confirmed=random.chance(0.3),
            stored_flags=[random.pick(flag_pool)] if random.chance(0.15) else [],
        )
        trigger = random.pick(triggers)
        auto = random.chance(0.5)
        decision = decide_outcome(f, trigger, auto_complete_on_idle=auto)  # type: ignore[arg-type]
        if not decision.finalize:
            assert trigger == "confirmSubmit"
            assert any(fields[i].status != "valid" for i in REQUIRED_RECORD_FIELDS)
            continue
        if decision.outcome == Outcome.COMPLETED:
            completed += 1
            assert all(fields[i].status == "valid" for i in REQUIRED_RECORD_FIELDS)
            assert (
                trigger == "confirmSubmit"
                or f.submit_confirmed
                or (trigger in ("idleTimeout", "testFinalize") and auto)
            )
            assert decision.review_flags == ()
            assert decision.missing_required == ()
        if trigger == "optOutConfirmed":
            assert decision.outcome == Outcome.OPTED_OUT
        if decision.outcome == Outcome.PARTIAL:
            assert decision.review_flags == ()
        if decision.review_flags and trigger != "optOutConfirmed":
            assert decision.outcome == Outcome.NEEDS_REVIEW
    assert completed > 50  # the generator does reach the interesting case


class TestCanReopen:
    CASES: list[tuple[Lifecycle, str, ReopenDecision]] = [
        (Lifecycle("finalized", Outcome.PARTIAL), "chatInput", ReopenDecision(True)),
        (Lifecycle("finalized", Outcome.COMPLETED), "callStarted", ReopenDecision(True)),
        (Lifecycle("finalized", Outcome.NEEDS_REVIEW), "callback", ReopenDecision(True)),
        (Lifecycle("finalized", Outcome.PARTIAL), "reconnect", ReopenDecision(False, "notUserActivity")),
        (Lifecycle("finalized", Outcome.OPTED_OUT), "chatInput", ReopenDecision(False, "resumeConfirmationRequired")),
        (Lifecycle("finalized", Outcome.OPTED_OUT), "callStarted", ReopenDecision(False, "resumeConfirmationRequired")),
        (Lifecycle("finalized", Outcome.OPTED_OUT), "resumeConfirmed", ReopenDecision(True)),
        (Lifecycle("closed", Outcome.PARTIAL), "chatInput", ReopenDecision(False, "closed")),
        (Lifecycle("closed", Outcome.OPTED_OUT), "resumeConfirmed", ReopenDecision(False, "closed")),
        (Lifecycle("active", None), "chatInput", ReopenDecision(False, "notFinalized")),
    ]

    @pytest.mark.parametrize(("lifecycle", "activity", "expected"), CASES)
    def test_can_reopen(self, lifecycle: Lifecycle, activity: str, expected: ReopenDecision) -> None:
        assert can_reopen(lifecycle, activity) == expected  # type: ignore[arg-type]
