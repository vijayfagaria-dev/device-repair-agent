# ruff: noqa: RUF001
"""Relative-date resolution in code (P2-T02; P0-T03 finding). TODAY is a Tuesday."""

from __future__ import annotations

import pytest

from app.domain.validators.spoken_date import ResolvedDate, is_unknown_date_phrase, resolve_spoken_date

TODAY = "2026-11-10"  # Tuesday


@pytest.mark.parametrize(
    ("phrase", "date", "precision"),
    [
        ("today", "2026-11-10", "day"),
        ("It started this morning", "2026-11-10", "day"),
        ("yesterday", "2026-11-09", "day"),
        ("last night", "2026-11-09", "day"),
        ("the day before yesterday", "2026-11-08", "day"),
        ("3 days ago", "2026-11-07", "day"),
        ("about ten days back", "2026-10-31", "day"),
        ("a week ago", "2026-11-03", "week"),
        ("a couple of weeks ago", "2026-10-27", "week"),
        ("a fortnight ago", "2026-10-27", "week"),
        ("about a month ago", "2026-10-10", "month"),
        ("three months ago", "2026-08-10", "month"),
        ("two years ago", "2024-11-10", "month"),
        ("last week", "2026-11-02", "week"),  # the Monday of the previous week
        (
            "Last week. Last Tuesday, I dropped it.",
            "2026-11-03",
            "day",
        ),  # live session 6e75: was the Monday, 2026-11-02
        ("last week on Friday", "2026-11-06", "day"),
        ("earlier this week", "2026-11-09", "week"),
        ("last month", "2026-10-01", "month"),
        ("sometime this month", "2026-11-01", "month"),
        ("last Tuesday", "2026-11-03", "day"),  # strictly before today, as P0-T03 defined it
        ("It started last Tuesday.", "2026-11-03", "day"),
        ("this past Tuesday", "2026-11-03", "day"),
        ("this Tuesday", "2026-11-10", "day"),
        ("on Monday", "2026-11-09", "day"),
        ("Sunday", "2026-11-08", "day"),
        ("last Wednesday", "2026-11-04", "day"),
        ("2026-11-01", "2026-11-01", "day"),
        ("3rd November", "2026-11-03", "day"),
        ("the 3rd of Nov", "2026-11-03", "day"),
        ("November 3rd 2025", "2025-11-03", "day"),
        ("25 December", "2025-12-25", "day"),  # this year's is still ahead, so last year's
        ("in October", "2026-10-01", "month"),
        ("December", "2025-12-01", "month"),
        ("October 2024", "2024-10-01", "month"),
        ("in May", "2026-05-01", "month"),
        ("it may have been in June", "2026-06-01", "month"),
        ("tomorrow", "2026-11-11", "day"),
        ("next week", "2026-11-16", "week"),
        ("ＹＥＳＴＥＲＤＡＹ", "2026-11-09", "day"),  # full-width (NFKC)
        # P2 audit: these used to resolve silently to the wrong date.
        ("3rd November last year", "2025-11-03", "day"),  # not this year's
        ("in October last year", "2025-10-01", "month"),
        ("next Tuesday", "2026-11-17", "day"),  # the coming one, so the validator says "in the future"
        ("next Friday", "2026-11-13", "day"),
        ("the Tuesday before last", "2026-10-27", "day"),  # a week before "last Tuesday"
        # Remaining branches.
        ("the day after tomorrow", "2026-11-12", "day"),
        ("next month", "2026-12-01", "month"),
        ("nov 3 2025", "2025-11-03", "day"),
        ("an hour ago", "2026-11-10", "day"),
    ],
)
def test_resolve_spoken_date(phrase: str, date: str, precision: str) -> None:
    assert resolve_spoken_date(phrase, TODAY) == ResolvedDate(date, precision)


@pytest.mark.parametrize(
    "phrase",
    [
        "around Diwali",
        "I sat on it",
        "it may be the battery",
        "31 November",
        "2026-02-30",
        "",
        "a while ago",
        "last year",
    ],
)
def test_cannot_be_resolved_so_the_agent_asks_again(phrase: str) -> None:
    assert resolve_spoken_date(phrase, TODAY) is None


def test_handles_month_ends_and_year_boundaries() -> None:
    assert resolve_spoken_date("a month ago", "2026-03-31") == ResolvedDate("2026-02-28", "month")
    assert resolve_spoken_date("yesterday", "2026-01-01") == ResolvedDate("2025-12-31", "day")
    assert resolve_spoken_date("last month", "2026-01-15") == ResolvedDate("2025-12-01", "month")
    assert resolve_spoken_date("last week", "2026-01-01") == ResolvedDate("2025-12-22", "week")


def test_a_non_existent_month_start_or_day_is_unresolved() -> None:
    assert resolve_spoken_date("30 February 2025", TODAY) is None
    assert resolve_spoken_date("March 1850", TODAY) is None


def test_recognises_dont_know_answers() -> None:
    for phrase in ["I don't know", "not sure", "no idea really", "can't remember"]:
        assert is_unknown_date_phrase(phrase), phrase
    assert not is_unknown_date_phrase("last week")
