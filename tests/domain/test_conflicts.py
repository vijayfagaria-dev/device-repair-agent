"""Conflict resolution (P2-T05, D15): class x {same, different, one invalid, both invalid, same-source correction,
latest wins, chatOnly spoken-only}."""

from __future__ import annotations

import dataclasses
import itertools
import json
from typing import Any

from app.domain.conflicts import Candidate, resolve_field, same_value

from .helpers import FILE, candidate, valid

IMEI_A = {"kind": "imei", "value": "352099001761481"}
IMEI_B = {"kind": "imei", "value": "490154203237518"}


def resolve_all_orders(field: str, history: list[Candidate]) -> Any:
    """Every permutation of the history must give the same result."""
    results = {
        json.dumps(dataclasses.asdict(resolve_field(field, list(p))), sort_keys=True)
        for p in itertools.permutations(history)
    }
    assert len(results) == 1, "result depends on input order"
    return resolve_field(field, history)


def has(result: Any, **expected: Any) -> bool:
    return all(getattr(result, k) == v for k, v in expected.items())


class TestNoCandidatesOneSourceInvalidAndSkipped:
    def test_is_missing_with_no_history(self) -> None:
        r = resolve_field("deviceType", [])
        assert (r.value, r.source, r.collected_at, r.status, r.conflict) == (None, None, None, "missing", None)

    def test_uses_a_single_valid_value_as_is(self) -> None:
        c = valid("call", "laptop")
        r = resolve_field("deviceType", [c])
        assert (r.value, r.source, r.collected_at, r.status, r.conflict) == (
            "laptop",
            "call",
            c.collected_at,
            "valid",
            None,
        )

    def test_is_invalid_with_no_value_when_every_candidate_is_invalid_recording_where_and_when(self) -> None:
        first = candidate("chat", "invalid", None)
        c = candidate("chat", "invalid", None)
        r = resolve_field("email", [c, first])
        assert (r.value, r.source, r.collected_at, r.status, r.conflict) == (
            None,
            "chat",
            c.collected_at,
            "invalid",
            None,
        )

    def test_keeps_the_latest_valid_value_when_a_later_answer_from_the_same_source_is_invalid(self) -> None:
        good = valid("call", {"brand": "Apple", "model": "iPhone 14"})
        r = resolve_all_orders("deviceModel", [good, candidate("call", "invalid", None)])
        assert has(r, status="valid", value=good.normalized)

    def test_lets_a_correction_from_the_same_source_replace_the_earlier_value(self) -> None:
        first = valid("chat", "asha@example.com")
        correction = valid("chat", "asha.rao@example.com")
        r = resolve_all_orders("email", [first, correction])
        assert has(r, status="valid", value="asha.rao@example.com", conflict=None)

    def test_reports_an_explicitly_skipped_optional_field_as_skipped(self) -> None:
        r = resolve_field("additionalNotes", [candidate("chat", "skipped", None)])
        assert has(r, status="skipped", value=None, source="chat")
        r = resolve_field("additionalNotes", [candidate("chat", "skipped", None), valid("chat", "gate code 12")])
        assert has(r, status="valid", value="gate code 12")

    def test_orders_by_commit_order_even_when_clocks_disagree_and_breaks_seq_ties_deterministically(self) -> None:
        later = valid("chat", "a@example.com", seq=10, collected_at="2026-11-07T04:30:00.000Z")
        earlier = valid("chat", "b@example.com", seq=9, collected_at="2026-11-07T05:00:00.000Z")
        assert resolve_all_orders("email", [later, earlier]).value == "a@example.com"
        tie_a = valid("chat", "a@example.com", seq=20, collected_at="2026-11-07T04:30:00.000Z")
        tie_b = valid("chat", "b@example.com", seq=20, collected_at="2026-11-07T04:30:00.000Z")
        resolve_all_orders("email", [tie_a, tie_b])

    def test_breaks_ties_by_time_then_source_then_status_then_value(self) -> None:
        # Same seq, different times: the later time wins.
        a = valid("chat", "a@example.com", seq=30, collected_at="2026-11-07T04:30:00.000Z")
        b = valid("chat", "b@example.com", seq=30, collected_at="2026-11-07T04:31:00.000Z")
        assert resolve_all_orders("email", [a, b]).value == "b@example.com"
        # Same seq and time, different source: chat is later (both sides valid -> a conflict, typed wins anyway).
        call = candidate("call", "valid", "a@example.com", seq=40, collected_at="2026-11-07T04:30:00.000Z")
        chat = candidate("chat", "valid", "b@example.com", seq=40, collected_at="2026-11-07T04:30:00.000Z")
        assert resolve_all_orders("deviceType", [call, chat]).source == "chat"
        # Same seq, time and source, different status: "valid" > "invalid" lexicographically, so it is the later one.
        inv = candidate("chat", "invalid", None, seq=50, collected_at="2026-11-07T04:30:00.000Z")
        ok = candidate("chat", "valid", "x@example.com", seq=50, collected_at="2026-11-07T04:30:00.000Z")
        assert resolve_all_orders("email", [inv, ok]).status == "valid"
        skipped = candidate("chat", "skipped", None, seq=60, collected_at="2026-11-07T04:30:00.000Z")
        invalid = candidate("chat", "invalid", None, seq=60, collected_at="2026-11-07T04:30:00.000Z")
        assert resolve_all_orders("additionalNotes", [skipped, invalid]).status == "skipped"


class TestIdentifierClass:
    """serialNumber, email: chatOnly, typed always wins."""

    def test_a_spoken_only_identifier_is_unverified_never_valid_even_if_the_model_marked_it_valid(self) -> None:
        for status in ("valid", "unverified"):
            heard = candidate("call", status, "asha@example.com")
            r = resolve_field("email", [heard])
            assert (r.value, r.source, r.collected_at, r.status, r.conflict) == (
                "asha@example.com",
                "call",
                heard.collected_at,
                "unverified",
                None,
            )

    def test_equal_typed_and_spoken_values_are_corroboration(self) -> None:
        result = resolve_all_orders(
            "email", [valid("chat", "Asha@example.com"), candidate("call", "unverified", "asha@example.com")]
        )
        assert has(result, status="valid", source="chat", value="Asha@example.com")
        assert has(result.conflict, resolution="same", reason="values equal after normalization", unresolved=False)

    def test_different_values_the_typed_one_wins(self) -> None:
        result = resolve_all_orders("serialNumber", [candidate("call", "unverified", IMEI_B), valid("chat", IMEI_A)])
        assert has(result, status="valid", source="chat", value=IMEI_A)
        assert dataclasses.asdict(result.conflict) == {
            "field": "serialNumber",
            "call_value": IMEI_B,
            "chat_value": IMEI_A,
            "resolution": "chatValue",
            "reason": "typed value preferred over spoken for identifiers",
            "unresolved": False,
        }

    def test_escalates_when_the_user_had_confirmed_the_spoken_value_until_they_confirm_the_typed_one(self) -> None:
        confirmed_spoken = candidate("call", "unverified", IMEI_B, user_confirmed=True)
        typed = valid("chat", IMEI_A)
        conflict = resolve_field("serialNumber", [confirmed_spoken, typed]).conflict
        assert has(conflict, resolution="chatValue", unresolved=True)
        assert conflict.reason == "typed value used, but the user had confirmed the spoken value; needs confirmation"
        # The user picks on the "which is correct?" card: a user-confirmed chat candidate (protocol.md section 5).
        picked = valid("chat", IMEI_B, user_confirmed=True)
        result = resolve_all_orders("serialNumber", [confirmed_spoken, typed, picked])
        assert result.value == IMEI_B
        assert has(result.conflict, resolution="same", unresolved=False)

    def test_ignores_an_invalid_typed_value_the_field_stays_unverified_until_a_valid_one_is_typed(self) -> None:
        r = resolve_field(
            "email", [candidate("call", "unverified", "a@example.com"), candidate("chat", "invalid", None)]
        )
        assert r.status == "unverified"


class TestChoiceClass:
    """deviceType, serviceCentre: most recent explicit choice."""

    def test_different_values_the_later_one_wins_whichever_channel(self) -> None:
        call_first = resolve_all_orders("deviceType", [valid("call", "tablet"), valid("chat", "laptop")])
        assert has(call_first, value="laptop", source="chat")
        assert has(call_first.conflict, resolution="chatValue", reason="most recent explicit choice")
        chat_first = resolve_all_orders("deviceType", [valid("chat", "laptop"), valid("call", "tablet")])
        assert has(chat_first, value="tablet", source="call")
        assert has(chat_first.conflict, resolution="callValue")

    def test_same_value_is_corroboration_one_side_invalid_means_no_conflict(self) -> None:
        centre = {"id": "mum-dadar", "name": "Dadar Demo Repair Centre", "city": "Mumbai"}
        same = resolve_all_orders(
            "serviceCentre", [valid("call", centre), valid("chat", {**centre, "name": "renamed"})]
        )
        assert same.conflict.resolution == "same"
        # Corroboration: the later of the two (call here, since it has the later seq) is the value shown.
        later_call = resolve_all_orders("serviceCentre", [valid("chat", centre), valid("call", centre)])
        assert later_call.source == "call"
        one_invalid = resolve_all_orders("serviceCentre", [valid("call", centre), candidate("chat", "invalid", None)])
        assert has(one_invalid, value=centre, source="call", conflict=None)


class TestNarrativeClass:
    """problemDescription, problemStartedAt, urgency: spoken preferred, typed kept as addendum."""

    def test_different_values_the_spoken_account_wins_even_when_the_typed_one_is_later(self) -> None:
        spoken = valid("call", {"level": "high", "reason": "work"})
        typed = valid("chat", {"level": "normal", "reason": None})
        result = resolve_all_orders("urgency", [spoken, typed])
        assert has(result, value=spoken.normalized, source="call")
        assert has(
            result.conflict,
            resolution="callValue",
            chat_value=typed.normalized,
            reason="spoken account preferred; typed version kept as an addendum",
        )

    def test_same_date_at_different_wording_is_still_the_same(self) -> None:
        result = resolve_all_orders(
            "problemStartedAt",
            [
                valid("call", {"date": "2026-11-03", "precision": "day", "spoken": "last Tuesday"}),
                valid("chat", {"date": "2026-11-03", "precision": "day", "spoken": None}),
            ],
        )
        assert result.conflict.resolution == "same"
        assert result.source == "call"

    def test_both_invalid_is_invalid(self) -> None:
        r = resolve_field(
            "problemDescription", [candidate("call", "invalid", None), candidate("chat", "invalid", None)]
        )
        assert r.status == "invalid"


class TestTypedPreferredClass:
    """deviceModel: typed wins for spelling."""

    def test_different_values_the_typed_model_wins(self) -> None:
        result = resolve_all_orders(
            "deviceModel",
            [
                valid("chat", {"brand": "Samsung", "model": "Galaxy S23"}),
                valid("call", {"brand": "Samsung", "model": "Galaxy S 23"}),
            ],
        )
        assert has(result, source="chat")
        assert has(result.conflict, resolution="chatValue", reason="typed value preferred for spelling")

    def test_compares_case_insensitively(self) -> None:
        assert same_value(
            "deviceModel", {"brand": "Apple", "model": "iPhone 14"}, {"brand": "apple", "model": "IPHONE 14"}
        )

    def test_compares_the_other_fields_by_their_identity_keys(self) -> None:
        assert same_value("email", "A@B.com", "a@b.COM")
        assert not same_value("email", "a@b.com", "c@b.com")
        assert same_value("serialNumber", {"kind": "imei", "value": "1"}, {"kind": "serial", "value": "1"})
        assert same_value(
            "problemDescription", {"verbatim": "Hello", "summary": "x"}, {"verbatim": "hello", "summary": "y"}
        )
        assert same_value("urgency", {"level": "high", "reason": "a"}, {"level": "high", "reason": None})
        assert same_value("deviceType", "laptop", "laptop")
        assert not same_value("deviceType", "laptop", "tablet")
        assert same_value("email", None, None)


class TestChatInputClass:
    """files, notes: call candidates are ignored."""

    def test_never_takes_a_value_from_the_call(self) -> None:
        assert resolve_field("purchaseInvoice", [valid("call", FILE)]).status == "missing"
        result = resolve_all_orders(
            "purchaseInvoice", [valid("call", {**FILE, "fileId": "other"}), valid("chat", FILE)]
        )
        assert has(result, value=FILE, conflict=None)
