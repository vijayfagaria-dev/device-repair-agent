"""Voice-field validators (P2-T02, D14): >= 8 table cases per field."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.domain.dates import ist_today
from app.domain.validators.voice_fields import (
    detect_brand,
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)

TODAY = "2026-11-10"


def ok(result: Any) -> Any:
    assert result.status == "valid", result
    return result.normalized


def err(result: Any) -> str | None:
    assert result.status == "invalid", result
    return result.error


class TestValidateDeviceType:
    @pytest.mark.parametrize(
        ("text", "device_type"),
        [
            ("smartphone", "smartphone"),
            ("It's my phone", "smartphone"),
            ("an iPhone", "smartphone"),
            ("my Samsung Galaxy S23", "smartphone"),
            ("Galaxy Watch", "smartwatch"),
            ("galaxy tab", "tablet"),
            ("my iPad", "tablet"),
            ("MacBook Air", "laptop"),
            ("a notebook computer", "laptop"),
            ("AirPods", "headphones"),
            ("wireless earbuds", "headphones"),
            ("Apple Watch", "smartwatch"),
            ("a desktop PC", "other"),
            ("something else", "other"),
            ("  LAPTOP ", "laptop"),
        ],
    )
    def test_maps_phrases(self, text: str, device_type: str) -> None:
        assert ok(validate_device_type(text)) == device_type

    @pytest.mark.parametrize("raw", ["a thing", "", "   ", "I don't know", None, 3])
    def test_rejects_with_a_spoken_reask(self, raw: Any) -> None:
        assert (
            err(validate_device_type(raw))
            == "Sorry, what kind of device is it: a phone, laptop, tablet, smartwatch or headphones?"
        )

    def test_does_not_read_headphones_as_a_phone(self) -> None:
        assert ok(validate_device_type("my headphones")) == "headphones"


class TestValidateDeviceModel:
    @pytest.mark.parametrize(
        ("text", "normalized"),
        [
            ("iPhone 14 Pro", {"brand": "Apple", "model": "iPhone 14 Pro"}),
            ("Apple iPhone 14 Pro", {"brand": "Apple", "model": "iPhone 14 Pro"}),
            ("Samsung Galaxy S23", {"brand": "Samsung", "model": "Galaxy S23"}),
            ("galaxy s23 ultra", {"brand": "Samsung", "model": "galaxy s23 ultra"}),
            ("Pixel 8", {"brand": "Google", "model": "Pixel 8"}),
            ("One Plus 12", {"brand": "OnePlus", "model": "12"}),
            ("Dell XPS 13", {"brand": "Dell", "model": "XPS 13"}),
            ("ThinkPad X1 Carbon", {"brand": "Lenovo", "model": "ThinkPad X1 Carbon"}),
            ("Samsung", {"brand": "Samsung", "model": None}),  # brand only still helps
            ("Zorbo X1", {"brand": None, "model": "Zorbo X1"}),  # unknown brand kept as said
        ],
    )
    def test_splits_brand_and_model(self, text: str, normalized: dict[str, Any]) -> None:
        assert ok(validate_device_model(text)) == normalized

    def test_accepts_the_tools_structured_brand_model(self) -> None:
        assert ok(validate_device_model({"brand": "Apple", "model": "iPhone 14"})) == {
            "brand": "Apple",
            "model": "iPhone 14",
        }

    def test_reasks_once_on_dont_know_then_accepts_unknown_when_the_controller_allows_it(self) -> None:
        assert (
            err(validate_device_model("I don't know"))
            == "No problem. Could you check the box, the label, or Settings, About? Even just the brand helps."
        )
        assert ok(validate_device_model("not sure", allow_unknown=True)) == {"brand": None, "model": None}

    @pytest.mark.parametrize(
        "text",
        [
            "Samsung, not sure of the model",
            "It's a Samsung but I don't know which model",
            "just Samsung, no idea about the model",
        ],
    )
    def test_keeps_the_brand_when_only_the_model_is_unknown(self, text: str) -> None:
        expected = {"brand": "Samsung", "model": None}
        assert ok(validate_device_model(text)) == expected
        assert ok(validate_device_model(text, allow_unknown=True)) == expected

    @pytest.mark.parametrize("raw", ["", "1", "12345", "x" * 81, None, {}])
    def test_rejects(self, raw: Any) -> None:
        assert err(validate_device_model(raw)) == "Which brand and model is it? For example, Samsung Galaxy S23."

    def test_detects_brands_by_whole_words_only(self) -> None:
        assert detect_brand("my hp laptop") == "HP"
        assert detect_brand("a happy phone") is None

    def test_a_brand_with_nothing_after_it_has_no_model(self) -> None:
        assert ok(validate_device_model("OnePlus")) == {"brand": "OnePlus", "model": None}
        assert ok(validate_device_model("Apple")) == {"brand": "Apple", "model": None}


class TestValidateProblemDescription:
    @pytest.mark.parametrize(
        "text",
        [
            "The screen flickers and goes black after a minute",
            "phone not charging",
            "battery drains very fast",
            "cracked screen after a drop",
            "um so like the speaker crackles at high volume",
            "it won't turn on at all",
            "water got inside and the camera is foggy",
            "keyboard keys stopped responding",
        ],
    )
    def test_accepts(self, text: str) -> None:
        value = ok(validate_problem_description(text))
        assert value["verbatim"] == text
        assert value["summary"] == text

    @pytest.mark.parametrize(
        "raw",
        [
            "it's broken",
            "it is broken",
            "my phone is not working",
            "um uh like you know",
            "problem",
            "",
            None,
            "screen cracked",
        ],
    )
    def test_asks_for_more(self, raw: Any) -> None:
        assert (
            err(validate_problem_description(raw))
            == "Could you tell me a bit more about what's wrong? For example, what happens when you use it?"
        )

    def test_keeps_the_models_summary_capped_at_300_characters_and_caps_the_verbatim_at_1000(self) -> None:
        verbatim = f"the screen flickers {'and then goes dark ' * 80}"
        value = ok(validate_problem_description({"summary": f"Screen flickers {'badly ' * 80}", "verbatim": verbatim}))
        assert len(value["summary"]) <= 300
        assert value["summary"].startswith("Screen flickers")
        assert len(value["verbatim"]) <= 1000

    def test_falls_back_to_the_summary_or_the_verbatim(self) -> None:
        assert (
            ok(validate_problem_description({"summary": "battery drains very fast"}))["verbatim"]
            == "battery drains very fast"
        )
        value = ok(validate_problem_description({"verbatim": "battery drains very fast", "summary": "  "}))
        assert value["summary"] == "battery drains very fast"


class TestValidateProblemStartedAt:
    @pytest.mark.parametrize(
        ("text", "normalized"),
        [
            ("yesterday", {"date": "2026-11-09", "precision": "day", "spoken": "yesterday"}),
            ("last Tuesday", {"date": "2026-11-03", "precision": "day", "spoken": "last Tuesday"}),
            ("two weeks ago", {"date": "2026-10-27", "precision": "week", "spoken": "two weeks ago"}),
            ("last month", {"date": "2026-10-01", "precision": "month", "spoken": "last month"}),
            ("2026-10-20", {"date": "2026-10-20", "precision": "day", "spoken": None}),  # the chat date card
            ("today", {"date": "2026-11-10", "precision": "day", "spoken": "today"}),
            ("9 years ago", {"date": "2017-11-10", "precision": "month", "spoken": "9 years ago"}),
            ("3rd November", {"date": "2026-11-03", "precision": "day", "spoken": "3rd November"}),
        ],
    )
    def test_resolves(self, text: str, normalized: dict[str, Any]) -> None:
        assert ok(validate_problem_started_at(text, today=TODAY)) == normalized

    def test_resolves_the_users_words_and_ignores_the_models_date_arithmetic(self) -> None:
        assert ok(validate_problem_started_at({"spoken": "last Tuesday", "date": "2026-11-02"}, today=TODAY)) == {
            "date": "2026-11-03",
            "precision": "day",
            "spoken": "last Tuesday",
        }
        assert (
            err(validate_problem_started_at({"spoken": "around Diwali", "date": "2026-10-20"}, today=TODAY))
            == "Roughly which date was that? For example, last Tuesday, or the 3rd of November."
        )
        assert ok(validate_problem_started_at({"date": "2026-11-02"}, today=TODAY)) == {
            "date": "2026-11-02",
            "precision": "day",
            "spoken": None,
        }

    def test_an_iso_phrase_inside_an_object_keeps_the_spoken_text(self) -> None:
        assert ok(validate_problem_started_at({"spoken": "2026-10-20"}, today=TODAY))["spoken"] == "2026-10-20"

    def test_yesterday_at_0030_ist_is_the_ist_calendars_yesterday_not_utcs(self) -> None:
        now = datetime(2026, 11, 9, 19, 0, tzinfo=UTC)  # 00:30 on 10 Nov in IST; still 9 Nov in UTC
        assert ist_today(now) == "2026-11-10"
        assert ok(validate_problem_started_at("yesterday", today=ist_today(now)))["date"] == "2026-11-09"

    @pytest.mark.parametrize(
        ("raw", "error"),
        [
            ("tomorrow", "That date is in the future. When did the problem start?"),
            ("2049-01-01", "That date is in the future. When did the problem start?"),
            ("next week", "That date is in the future. When did the problem start?"),
            ("12 years ago", "That's more than 10 years ago. When did the problem start?"),
            ("2015-01-01", "That's more than 10 years ago. When did the problem start?"),
            ("I don't know", "No problem. Roughly when did it start: a few days ago, last week, or a month ago?"),
            ("around Diwali", "Roughly which date was that? For example, last Tuesday, or the 3rd of November."),
            ("2026-02-30", "Please choose a valid date."),
            ("", "Please choose a valid date."),
            (None, "Please choose a valid date."),
            ({"date": "not a date"}, "Please choose a valid date."),
        ],
    )
    def test_rejects(self, raw: Any, error: str) -> None:
        assert err(validate_problem_started_at(raw, today=TODAY)) == error


class TestValidateUrgency:
    @pytest.mark.parametrize(
        ("text", "normalized"),
        [
            ("high", {"level": "high", "reason": None}),
            ("I need it for work tomorrow", {"level": "high", "reason": "I need it for work tomorrow"}),
            ("no rush really", {"level": "low", "reason": "no rush really"}),
            ("it's not urgent", {"level": "low", "reason": "it's not urgent"}),
            ("within a few days is fine", {"level": "normal", "reason": "within a few days is fine"}),
            (
                "it's an emergency, I can't manage without it",
                {"level": "critical", "reason": "it's an emergency, I can't manage without it"},
            ),
            ("as soon as possible", {"level": "high", "reason": "as soon as possible"}),
            ("sometime next week", {"level": "normal", "reason": "sometime next week"}),
            ("whenever", {"level": "low", "reason": "whenever"}),
        ],
    )
    def test_maps_phrases(self, text: str, normalized: dict[str, Any]) -> None:
        assert ok(validate_urgency(text)) == normalized

    def test_takes_the_tools_level_reason_mapping_the_reason_when_the_level_is_not_a_known_value(self) -> None:
        assert ok(validate_urgency({"level": "critical", "reason": "medical device"})) == {
            "level": "critical",
            "reason": "medical device",
        }
        assert ok(validate_urgency({"level": "very", "reason": "need it for work"})) == {
            "level": "high",
            "reason": "need it for work",
        }
        assert validate_urgency({"reason": f"{'x' * 400} urgent"}).status == "valid"
        # A reason that is just a level word is dropped.
        assert ok(validate_urgency({"level": "high", "reason": "High"})) == {"level": "high", "reason": None}

    @pytest.mark.parametrize(
        ("text", "level"),
        [
            ("the battery is low and I need it urgently", "high"),  # "low" alone is not an urgency
            ("it's not critical, but I'd like it this week", "normal"),
            ("no, it's urgent", "high"),  # a bare "no" doesn't negate
            ("not immediately, whenever is fine", "low"),
        ],
    )
    def test_does_not_read_negated_or_incidental_words_as_a_level(self, text: str, level: str) -> None:
        assert ok(validate_urgency(text))["level"] == level

    @pytest.mark.parametrize(
        "raw",
        [
            "hmm",
            "",
            None,
            {"level": "purple"},
            "it's not an emergency",
            "it's not critical",
            "I don't need it right away",
        ],
    )
    def test_asks_again(self, raw: Any) -> None:
        assert (
            err(validate_urgency(raw))
            == "How soon do you need it back: no rush, within a few days, urgently, or immediately?"
        )
