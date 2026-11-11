"""Resolves spoken dates ("last Tuesday", "two weeks ago", "3rd November") against the session's IST date (P2-T02).
P0-T03 measured the model getting "last Tuesday" wrong in 3 of 3 passes, so relative dates are resolved here, in
code, from the user's words; the model's own date arithmetic is never trusted.

All patterns use re.ASCII so `\\b` and `\\d` behave like the JS originals (which had no `u` flag)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..dates import (
    CivilDate,
    add_days,
    add_months,
    civil_date,
    is_civil_date,
    start_of_month,
    start_of_week,
    weekday,
)
from .strings import clean_text


@dataclass(frozen=True, slots=True)
class ResolvedDate:
    date: CivilDate
    precision: str  # "day" | "week" | "month"


NUMBER_WORDS = {
    "a": 1,
    "an": 1,
    "one": 1,
    "two": 2,
    "couple": 2,
    "three": 3,
    "few": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}
WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
]
MONTH_PATTERN = (
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?"
    "|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
# Full names only: abbreviations collide with ordinary words ("I sat on it", "mar the screen").
WEEKDAY_PATTERN = f"({'|'.join(WEEKDAYS)})"
FULL_MONTH_PATTERN = f"({'|'.join(MONTHS)})"


def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.ASCII)


# Phrases meaning the user doesn't know, so the agent asks for a rough answer instead of a date.
_UNKNOWN = _rx(
    r"\b(?:dont know|do not know|not sure|no idea|cant remember|can not remember|cannot remember|dont remember"
    r"|no clue|unsure)\b"
)

_DAY_AFTER_TOMORROW = _rx(r"\bday after tomorrow\b")
_TOMORROW = _rx(r"\btomorrow\b")
_NEXT_WEEK = _rx(r"\bnext week\b")
_NEXT_MONTH = _rx(r"\bnext month\b")
_DAY_BEFORE_YESTERDAY = _rx(r"\bday before yesterday\b")
_YESTERDAY = _rx(r"\b(?:yesterday|last night)\b")
_TODAY = _rx(r"\b(?:today|this morning|this afternoon|this evening|tonight|just now|an hour ago|few hours ago)\b")
_FORTNIGHT = _rx(r"\b(?:a )?fortnight (?:ago|back)\b")
_AGO = _rx(
    r"\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)(?: of)? "
    r"(day|week|month|year)s? (?:ago|back|before)\b"
)
_LAST_WEEK = _rx(r"\blast week\b")
_THIS_WEEK = _rx(r"\bthis week\b")
_LAST_MONTH = _rx(r"\blast month\b")
_THIS_MONTH = _rx(r"\bthis month\b")
_ISO = _rx(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_LAST_YEAR = _rx(r"\blast year\b")
_DAY_MONTH = _rx(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?(?: of)? {MONTH_PATTERN}\b(?: (\d{{4}}))?")
_MONTH_DAY = _rx(rf"\b{MONTH_PATTERN} (\d{{1,2}})(?:st|nd|rd|th)?\b(?: (\d{{4}}))?")
_WEEKDAY = _rx(rf"\b{WEEKDAY_PATTERN}\b")
_NEXT_WEEKDAY = _rx(rf"\bnext {WEEKDAY_PATTERN}\b")
_WEEKDAY_BEFORE_LAST = _rx(rf"\b{WEEKDAY_PATTERN} before last\b")
_THIS_WEEKDAY = _rx(rf"\bthis {WEEKDAY_PATTERN}\b")
_THIS_PAST = _rx(r"\bthis past\b")
_MONTHS = _rx(rf"(?:\b(in|since|during|early|mid|late|around|of) )?\b{FULL_MONTH_PATTERN}\b(?: (\d{{4}}))?")
# \s is Unicode-aware here (as in JS), so it is the one pattern without re.ASCII.
_SPACES = re.compile(r"\s+")


def _month_index(name: str) -> int:
    prefix = name[:3]
    for i, month in enumerate(MONTHS):
        if month.startswith(prefix):
            return i
    return -1


def _weekday_index(name: str) -> int:
    prefix = name[:3]
    for i, day in enumerate(WEEKDAYS):
        if day.startswith(prefix):
            return i
    return -1


def _parse_count(token: str) -> int | None:
    if re.fullmatch(r"\d{1,3}", token, re.ASCII):
        return int(token)
    return NUMBER_WORDS.get(token)


def _previous_weekday(today: CivilDate, day: int) -> CivilDate:
    """The most recent `day` strictly before `today` (1-7 days back), as the P0-T03 test defined "last Tuesday"."""
    return add_days(today, -((weekday(today) - day + 7) % 7 or 7))


def _latest_past(today: CivilDate, month: int, day: int, last_year: bool) -> CivilDate | None:
    """A month/day with no year means its most recent occurrence: this year, or last year if that's still ahead.
    "... last year" means last year's, always."""
    year = int(today[:4])
    if last_year:
        return civil_date(year - 1, month, day)
    this_year = civil_date(year, month, day)
    if this_year and this_year <= today:
        return this_year
    return civil_date(year - 1, month, day)


def _normalize_phrase(phrase: str) -> str:
    text = clean_text(phrase, form="NFKC").lower().replace("’", "").replace("'", "")  # noqa: RUF001
    text = re.sub(r"[,.!?]", " ", text)
    return _SPACES.sub(" ", text).strip()


def is_unknown_date_phrase(phrase: str) -> bool:
    return _UNKNOWN.search(_normalize_phrase(phrase)) is not None


def resolve_spoken_date(phrase: str, today: CivilDate) -> ResolvedDate | None:
    """Returns the date the phrase means (relative to `today`, in IST), or None when it can't be resolved."""
    text = _normalize_phrase(phrase)
    if text == "":
        return None

    # Future phrases resolve too, so the caller can say "that's in the future" instead of "which date?".
    if _DAY_AFTER_TOMORROW.search(text):
        return ResolvedDate(add_days(today, 2), "day")
    if _TOMORROW.search(text):
        return ResolvedDate(add_days(today, 1), "day")
    if _NEXT_WEEK.search(text):
        return ResolvedDate(add_days(start_of_week(today), 7), "week")
    if _NEXT_MONTH.search(text):
        return ResolvedDate(start_of_month(add_months(start_of_month(today), 1)), "month")
    if _DAY_BEFORE_YESTERDAY.search(text):
        return ResolvedDate(add_days(today, -2), "day")
    if _YESTERDAY.search(text):
        return ResolvedDate(add_days(today, -1), "day")
    if _TODAY.search(text):
        return ResolvedDate(today, "day")

    # "3 days ago", "a couple of weeks back", "about a month ago", "a fortnight ago"
    if _FORTNIGHT.search(text):
        return ResolvedDate(add_days(today, -14), "week")
    match = _AGO.search(text)
    if match:
        count = _parse_count(match.group(1))
        if count is None:
            return None
        unit = match.group(2)
        if unit == "day":
            return ResolvedDate(add_days(today, -count), "day")
        if unit == "week":
            return ResolvedDate(add_days(today, -7 * count), "week")
        if unit == "month":
            return ResolvedDate(add_months(today, -count), "month")
        return ResolvedDate(add_months(today, -12 * count), "month")

    if _LAST_WEEK.search(text):
        # "last week, last Tuesday": the named weekday of last week (weeks start on Monday), not the week's start.
        named = _WEEKDAY.search(text)
        if named:
            offset = (_weekday_index(named.group(1)) + 6) % 7
            return ResolvedDate(add_days(start_of_week(today), -7 + offset), "day")
        return ResolvedDate(add_days(start_of_week(today), -7), "week")
    if _THIS_WEEK.search(text):
        return ResolvedDate(start_of_week(today), "week")
    if _LAST_MONTH.search(text):
        return ResolvedDate(start_of_month(add_months(start_of_month(today), -1)), "month")
    if _THIS_MONTH.search(text):
        return ResolvedDate(start_of_month(today), "month")

    # ISO date (the chat date card, or a model that passed one as the phrase)
    match = _ISO.search(text)
    if match:
        iso = f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
        return ResolvedDate(iso, "day") if is_civil_date(iso) else None

    # "3rd November", "3 nov 2025", "November 3rd", "nov 3 2025", "3rd November last year"
    last_year = _LAST_YEAR.search(text) is not None
    day_month = None
    match = _DAY_MONTH.search(text)
    if match:
        day_month = (int(match.group(1)), _month_index(match.group(2)) + 1, match.group(3))
    month_day = None
    match = _MONTH_DAY.search(text)
    if match:
        month_day = (int(match.group(2)), _month_index(match.group(1)) + 1, match.group(3))
    dated = day_month or month_day
    if dated:
        d, m, year = dated
        resolved = civil_date(int(year), m, d) if year else _latest_past(today, m, d, last_year)
        return ResolvedDate(resolved, "day") if resolved else None

    # "last Tuesday", "on Monday", "this past Friday", "Wednesday", "the Tuesday before last", "next Friday"
    match = _WEEKDAY.search(text)
    if match:
        day = _weekday_index(match.group(1))
        if day < 0:
            return None
        # The coming one: resolved (not re-asked), so the caller can say "that's in the future".
        if _NEXT_WEEKDAY.search(text):
            return ResolvedDate(add_days(today, (day - weekday(today) + 7) % 7 or 7), "day")
        if _WEEKDAY_BEFORE_LAST.search(text):
            return ResolvedDate(add_days(_previous_weekday(today, day), -7), "day")
        if _THIS_WEEKDAY.search(text) and not _THIS_PAST.search(text) and weekday(today) == day:
            return ResolvedDate(today, "day")
        return ResolvedDate(_previous_weekday(today, day), "day")

    # "in October", "October 2025", "early March". "May" alone is usually the verb, so it needs a preposition.
    for found in _MONTHS.finditer(text):
        if found.group(2) == "may" and found.group(1) is None and found.group(3) is None:
            continue
        month = _month_index(found.group(2)) + 1
        if found.group(3):
            year = int(found.group(3))
        else:
            year = int(today[:4]) - (1 if last_year or month > int(today[5:7]) else 0)
        resolved = civil_date(year, month, 1)
        return ResolvedDate(resolved, "month") if resolved else None

    return None
