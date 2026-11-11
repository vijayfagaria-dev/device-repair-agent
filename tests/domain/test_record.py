# ruff: noqa: RUF001
"""The record builder and JSON Schema (P2-T07): golden records for the 4 outcomes, a 1,000-case fuzz test through the
real validators, content-hash properties, and the typed schema error."""

from __future__ import annotations

import copy
import json
import os
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.domain.canonical_json import CanonicalJsonError, canonical_json
from app.domain.conflicts import ResolvedField
from app.domain.record import (
    BuiltRecord,
    PreviousRevision,
    RecordInput,
    RecordSchemaError,
    build_record,
    content_hash,
    validate_record,
)

from .fuzz import random_record_input
from .helpers import prng
from .scenarios import SCENARIOS, signer

GOLDEN_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "golden"


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_golden_record_matches_and_validates(name: str) -> None:
    built = build_record(SCENARIOS[name]())
    assert built.record["outcome"] == name
    path = GOLDEN_DIR / f"{name}.json"
    actual = (
        json.dumps({"contentHash": built.content_hash, "record": built.record}, indent=2, ensure_ascii=False) + "\n"
    )
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.write_text(actual, encoding="utf-8")
    assert path.exists(), f"missing {path}; run with UPDATE_GOLDEN=1 and review the output"
    expected = path.read_text(encoding="utf-8")
    assert actual == expected
    # The golden file is the TS output: the hash it records must be what Python computes.
    assert json.loads(expected)["contentHash"] == built.content_hash


def test_the_golden_content_is_what_the_scenarios_intend() -> None:
    completed = build_record(SCENARIOS["completed"]()).record
    assert completed["missingRequired"] == []
    assert completed["submitConfirmation"] == {"confirmed": True, "source": "chat", "at": "2026-11-10T10:16:30+05:30"}
    assert completed["conflicts"] == [
        {
            "field": "email",
            "callValue": "asha.rao@example.com",
            "chatValue": "Asha.Rao@example.com",
            "resolution": "same",
            "reason": "values equal after normalization",
        }
    ]
    serial = completed["fields"]["serialNumber"]
    assert serial["status"] == "valid"
    assert serial["value"] == {"kind": "imei", "value": "352099001761481"}
    invoice = completed["fields"]["purchaseInvoice"]["value"]
    assert invoice["fileId"] == "fInvoice7Kq2Lm9x"
    assert invoice["url"] == signer("fInvoice7Kq2Lm9x")
    photos = completed["fields"]["additionalPhotos"]
    assert photos["status"] == "skipped"
    assert photos["value"] is None
    assert completed["previousRevision"] == {"revision": 1, "outcome": "partial"}

    partial = build_record(SCENARIOS["partial"]()).record
    assert partial["missingRequired"] == ["purchaseInvoice", "email"]
    email = partial["fields"]["email"]
    assert (email["status"], email["source"], email["value"]) == ("unverified", "call", "asha.rao@example.com")
    assert partial["outcomeReason"] == "idle timeout with required fields missing: purchaseInvoice, email (unverified)"

    needs_review = build_record(SCENARIOS["needsReview"]()).record
    assert [f["rule"] for f in needs_review["reviewFlags"]] == ["R-1", "R-2"]
    assert [[c["field"], c["resolution"]] for c in needs_review["conflicts"]] == [
        ["urgency", "callValue"],
        ["serialNumber", "chatValue"],
    ]

    opted_out = build_record(SCENARIOS["optedOut"]()).record
    problem = opted_out["fields"]["problemDescription"]
    assert (problem["status"], problem["value"], problem["source"]) == ("invalid", None, "call")


def test_is_a_final_record_so_the_starter_ui_can_render_it() -> None:
    wire: dict[str, Any] = build_record(SCENARIOS["completed"]()).record
    assert wire["fields"]["deviceType"]["status"] == "valid"
    # JSON-serializable as is (what the WebSocket and the REST API send).
    assert json.loads(json.dumps(wire)) == wire


def test_build_record_returns_a_named_pair() -> None:
    built = build_record(SCENARIOS["completed"]())
    assert isinstance(built, BuiltRecord)
    record, digest = built
    assert record is built.record
    assert digest == built.content_hash


class TestContentHash:
    """Content hash (D17)."""

    @staticmethod
    def hash_of(value: RecordInput) -> str:
        return build_record(value).content_hash

    def test_is_a_sha256_hex_digest_stable_across_builds(self) -> None:
        base = SCENARIOS["completed"]
        assert len(self.hash_of(base())) == 64
        assert all(c in "0123456789abcdef" for c in self.hash_of(base()))
        assert self.hash_of(base()) == self.hash_of(base())

    def test_does_not_change_with_engagement_cost_build_or_end_time_or_fresh_file_urls(self) -> None:
        from app.domain.record import CostBreakdown, Engagement, RecordCost

        base = SCENARIOS["completed"]
        original = self.hash_of(base())
        engagement = Engagement(
            calls=3, call_seconds=999, chat_messages=40, chat_inputs_submitted=12, invalid_attempts=7
        )
        assert self.hash_of(replace(base(), engagement=engagement)) == original
        cost = RecordCost(
            cost_usd=9, cost_breakdown_usd=CostBreakdown(stt=1, llm=2, tts=3, vision=3), actual_spend_usd=0
        )
        assert self.hash_of(replace(base(), cost=cost)) == original
        later = datetime(2027, 1, 1, tzinfo=UTC)
        assert self.hash_of(replace(base(), now=later, ended_at=later)) == original
        resigned = replace(
            base(), sign_file_url=lambda i: f"https://repair.example.com/files/{i}?exp=1999999999&sig=OTHER"
        )
        assert self.hash_of(resigned) == original
        assert (
            self.hash_of(replace(base(), revision=7, previous_revision=PreviousRevision(6, base().outcome))) == original
        )

    def test_changes_when_the_claim_changes(self) -> None:
        base = SCENARIOS["completed"]
        original = self.hash_of(base())
        value = base()
        email = replace(value.fields["email"], value="other@example.com")
        assert self.hash_of(replace(value, fields={**value.fields, "email": email})) != original
        assert self.hash_of(replace(value, outcome_reason="different")) != original
        from app.domain.outcome import ReviewFlag

        assert (
            self.hash_of(replace(value, review_flags=[ReviewFlag("R-5", "agent")], outcome="needsReview")) != original
        )
        assert self.hash_of(replace(value, submit_confirmed_at="2026-11-10T04:46:31Z")) != original

    def test_is_unchanged_by_key_order_in_the_input_values(self) -> None:
        def reverse_keys(value: Any) -> Any:
            if isinstance(value, list):
                return [reverse_keys(v) for v in value]
            if isinstance(value, dict):
                return {k: reverse_keys(v) for k, v in reversed(list(value.items()))}
            return value

        value = SCENARIOS["completed"]()
        reordered_fields = {
            i: replace(f, value=reverse_keys(f.value)) if isinstance(f, ResolvedField) else f
            for i, f in value.fields.items()
        }
        reordered = replace(value, fields=reordered_fields)
        assert self.hash_of(reordered) == self.hash_of(value)
        assert json.dumps(build_record(reordered).record) == json.dumps(build_record(value).record)


class TestCanonicalJson:
    def test_sorts_keys_at_every_level_and_keeps_array_order(self) -> None:
        assert canonical_json({"b": 1, "a": {"d": [3, 1], "c": None}}) == '{"a":{"c":null,"d":[3,1]},"b":1}'
        assert canonical_json({"a": 1, "b": 2}) == canonical_json({"b": 2, "a": 1})

    @pytest.mark.parametrize(
        "bad",
        [float("nan"), float("inf"), float("-inf"), datetime(2026, 1, 1), lambda: 1, {1, 2}, b"x", {1: "x"}, object()],
    )
    def test_refuses_values_json_cannot_represent_faithfully(self, bad: Any) -> None:
        with pytest.raises(CanonicalJsonError):
            canonical_json(bad)

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (5.0, "5"),
            (-0.0, "0"),
            (0, "0"),
            (0.1, "0.1"),
            (0.0123, "0.0123"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (1e-6, "0.000001"),
            (123456789.125, "123456789.125"),
            (-2.5, "-2.5"),
            (2**60, "1152921504606847000"),
            (True, "true"),
            (False, "false"),
            (None, "null"),
        ],
    )
    def test_formats_numbers_like_javascript(self, value: Any, expected: str) -> None:
        assert canonical_json(value) == expected

    def test_escapes_strings_like_json_stringify(self) -> None:
        assert canonical_json('a"b\\c\n\t\u0001\u007f é 😀') == '"a\\"b\\\\c\\n\\t\\u0001\u007f é 😀"'
        assert canonical_json("\ud800") == '"\\ud800"'
        assert canonical_json(("x", "y")) == '["x","y"]'

    def test_orders_keys_by_utf16_code_unit_like_js_sort(self) -> None:
        # U+FF5E (BMP) sorts after U+1F600 (surrogate pair D83D DE00) in UTF-16, before it by code point.
        assert canonical_json({"～": 1, "\U0001f600": 2}) == '{"😀":2,"～":1}'


class TestSchemaFailures:
    def test_throws_a_typed_error_naming_the_paths_never_the_values(self) -> None:
        record = copy.deepcopy(build_record(SCENARIOS["completed"]()).record)
        record["fields"]["email"] = {
            "value": "secret-value@example.com",
            "source": "chat",
            "collectedAt": None,
            "status": "valid",
        }
        record["extra"] = "secret-extra"
        with pytest.raises(RecordSchemaError) as caught:
            validate_record(record)
        problems = caught.value.problems
        assert any(p.path == "/fields/email/collectedAt" for p in problems)
        assert any(p.keyword == "additionalProperties" for p in problems)
        assert "secret" not in str(caught.value)

    def test_build_record_refuses_a_value_the_schema_does_not_allow(self) -> None:
        value = SCENARIOS["completed"]()
        with pytest.raises(RecordSchemaError):
            build_record(replace(value, missing_required=["email"]))
        with pytest.raises(RecordSchemaError):
            build_record(replace(value, session_id="not-a-uuid"))

    def test_strips_anything_the_schema_does_not_name_from_values(self) -> None:
        value = SCENARIOS["completed"]()
        sneaky = replace(
            value.fields["deviceModel"],
            value={"brand": "Apple", "model": "iPhone 14 Pro", "evidence": "transcript...", "path": "/tmp/x"},
        )
        record = build_record(replace(value, fields={**value.fields, "deviceModel": sneaky})).record
        assert record["fields"]["deviceModel"]["value"] == {"brand": "Apple", "model": "iPhone 14 Pro"}

    def test_projects_edge_shapes(self) -> None:
        from app.domain.record import project_value, without_file_urls

        assert project_value("additionalPhotos", "not a list", signer) is None
        assert project_value("purchaseInvoice", {"no": "fileId"}, signer) is None
        assert project_value("deviceType", 5, signer) is None
        assert project_value("unknownField", "x", signer) is None
        assert project_value("deviceType", None, signer) is None
        assert without_file_urls((1, {"url": "x", "k": [{"url": "y", "z": 1}]})) == [1, {"k": [{"z": 1}]}]


class TestFuzz:
    def test_every_finalized_record_validates_against_the_schema_and_validators_never_throw(self) -> None:
        """1,000 random candidate sets."""
        random = prng(7_2026_11_10)
        outcomes: dict[str, int] = {}
        built = 0
        for _ in range(1000):
            result = build_record(random_record_input(random))  # raises RecordSchemaError on any invalid record
            assert result.content_hash == content_hash(result.record)
            built += 1
            outcomes[result.record["outcome"]] = outcomes.get(result.record["outcome"], 0) + 1
        assert built == 1000
        assert sorted(outcomes) == ["completed", "needsReview", "optedOut", "partial"]
