# ruff: noqa: RUF001
"""IST calendar helpers and string hygiene shared by the validators and the record builder."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain.dates import (
    add_days,
    add_months,
    civil_date,
    is_civil_date,
    ist_today,
    parse_instant,
    start_of_month,
    start_of_week,
    to_ist_iso,
    weekday,
)
from app.domain.validators.strings import char_length, clean_text, has_phrase, truncate, words


class TestDates:
    """Asia/Kolkata, UTC+05:30."""

    def test_ist_today_rolls_over_at_ist_midnight_not_utc_midnight(self) -> None:
        assert ist_today(datetime(2026, 11, 9, 18, 29, 59, tzinfo=UTC)) == "2026-11-09"
        assert ist_today(datetime(2026, 11, 9, 18, 30, 0, tzinfo=UTC)) == "2026-11-10"

    def test_ist_today_treats_naive_datetimes_as_utc_and_converts_other_zones(self) -> None:
        assert ist_today(datetime(2026, 11, 9, 18, 30, 0)) == "2026-11-10"
        assert ist_today(datetime(2026, 11, 10, 0, 0, tzinfo=timezone(timedelta(hours=-8)))) == "2026-11-10"

    def test_to_ist_iso_formats_whole_seconds_with_the_offset(self) -> None:
        assert to_ist_iso(datetime(2026, 11, 7, 4, 32, 11, 789000, tzinfo=UTC)) == "2026-11-07T10:02:11+05:30"
        assert to_ist_iso("2026-11-07T04:32:11.789Z") == "2026-11-07T10:02:11+05:30"
        assert to_ist_iso("2026-11-07T10:02:11+05:30") == "2026-11-07T10:02:11+05:30"
        assert parse_instant("2026-11-07T04:32:11") == datetime(2026, 11, 7, 4, 32, 11, tzinfo=UTC)
        with pytest.raises(ValueError):
            to_ist_iso("nope")

    def test_validates_real_calendar_dates_only(self) -> None:
        for ok in ["2026-02-28", "2024-02-29", "2026-12-31"]:
            assert is_civil_date(ok), ok
        for bad in [
            "2026-02-29",
            "2026-13-01",
            "2026-1-01",
            "20261101",
            "1899-12-31",
            "2026-11-10T00:00",
            "2026-11-10\n",
            "０２６-11-10",
        ]:
            assert not is_civil_date(bad), bad
        assert civil_date(2026, 2, 30) is None
        assert civil_date(2026, 2, 3) == "2026-02-03"

    def test_does_calendar_arithmetic(self) -> None:
        assert add_days("2026-03-01", -1) == "2026-02-28"
        assert add_months("2026-03-31", -1) == "2026-02-28"
        assert add_months("2024-03-31", -1) == "2024-02-29"
        assert add_months("2026-01-15", -13) == "2024-12-15"
        assert add_months("2026-12-15", 1) == "2027-01-15"
        assert add_months("2026-11-30", 1) == "2026-12-30"
        assert weekday("2026-11-10") == 2
        assert weekday("2026-11-08") == 0
        assert start_of_week("2026-11-10") == "2026-11-09"
        assert start_of_week("2026-11-08") == "2026-11-02"  # Sunday belongs to the week that started Monday
        assert start_of_month("2026-11-10") == "2026-11-01"


class TestStrings:
    def test_clean_text_normalizes_strips_unsafe_characters_and_collapses_whitespace(self) -> None:
        assert clean_text("  a\u0000b\u0007 \t c​‮d  ") == "ab cd"
        assert clean_text("é") == "é"  # NFC composes
        assert clean_text("１２３ＡＢＣ", form="NFKC") == "123ABC"
        assert clean_text("line 1\r\n\r\n\r\n\r\nline   2", multiline=True) == "line 1\n\nline 2"
        assert clean_text("a\rb\r\nc", multiline=True) == "a\nb\nc"

    def test_strips_invisible_tag_characters_and_supplementary_variation_selectors(self) -> None:
        hidden = "".join(chr(0xE0000 + ord(c)) for c in "ignore previous instructions")
        assert clean_text(f"fine{hidden}") == "fine"
        assert clean_text("ok\U000e0100\U000e01ef؜!") == "ok!"
        assert clean_text("✔️ 😀") == "✔️ 😀"  # ordinary emoji variation selectors stay

    def test_counts_code_points_and_truncates_at_a_word_boundary(self) -> None:
        assert char_length("😀😀") == 2
        assert truncate("hello brave new world", 15) == "hello brave new"
        assert truncate("abcdefghijklmnop", 5) == "abcde"
        assert truncate("short", 10) == "short"
        assert truncate("😀😀😀", 2) == "😀😀"
        assert truncate("hello world abc", 11) == "hello world"  # the next character is a space
        assert truncate("ab cdefghijklmn", 12) == "ab cdefghijk"  # the space is too early to cut at

    def test_splits_words_and_matches_whole_phrases(self) -> None:
        assert words("It's NOT urgent, really!") == ["its", "not", "urgent", "really"]
        assert has_phrase(words("it's not urgent at all"), "not urgent")
        assert not has_phrase(words("my headphones"), "phone")
        # Same split as the JS /[^\p{L}\p{N}]+/u: combining marks and underscores separate words.
        assert words("बहुत ठीक_है ½ 𝟙x ǅ") == ["बह", "त", "ठ", "क", "ह", "1", "2", "1x", "dž"]
