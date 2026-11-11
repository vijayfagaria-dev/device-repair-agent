"""Calendar dates in the claim's timezone (D14: Asia/Kolkata, UTC+05:30 all year, no daylight saving). "Today" always
comes from the server clock, never from the model."""

from __future__ import annotations

import calendar
import re
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    IST: tzinfo = ZoneInfo("Asia/Kolkata")
except ZoneInfoNotFoundError:  # no tz database installed: IST has had no DST since 1945, a fixed offset is identical
    IST = timezone(timedelta(hours=5, minutes=30), "IST")

_ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)

# A civil date "YYYY-MM-DD" in IST.
CivilDate = str


def _as_aware(instant: datetime) -> datetime:
    return instant if instant.tzinfo is not None else instant.replace(tzinfo=UTC)


def parse_instant(value: str | datetime) -> datetime:
    """An ISO 8601 string (or datetime) as an aware datetime; naive values are UTC. Raises ValueError when invalid."""
    if isinstance(value, datetime):
        return _as_aware(value)
    return _as_aware(datetime.fromisoformat(value))


def ist_today(now: datetime) -> CivilDate:
    """Today's date in IST at the instant `now`."""
    return _as_aware(now).astimezone(IST).date().isoformat()


def to_ist_iso(instant: datetime | str) -> str:
    """ "2026-11-07T10:02:11+05:30": the record's timestamp format (whole seconds, IST offset)."""
    local = parse_instant(instant).astimezone(IST).replace(microsecond=0)
    return local.isoformat()


def is_civil_date(value: str) -> bool:
    """True only for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30)."""
    match = _ISO_DATE.fullmatch(value)
    if not match:
        return False
    year, month, day = (int(g) for g in match.groups())
    if year < 1900:
        return False
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def _to_date(value: CivilDate) -> date:
    return date.fromisoformat(value)


def add_days(value: CivilDate, days: int) -> CivilDate:
    return (_to_date(value) + timedelta(days=days)).isoformat()


def add_months(value: CivilDate, months: int) -> CivilDate:
    """Same day of the month `months` later (negative = earlier), clamped to the month's last day (Mar 31 - 1 -> Feb 28)."""
    d = _to_date(value)
    year, month0 = divmod(d.year * 12 + (d.month - 1) + months, 12)
    last_day = calendar.monthrange(year, month0 + 1)[1]
    return date(year, month0 + 1, min(d.day, last_day)).isoformat()


def weekday(value: CivilDate) -> int:
    """0 = Sunday ... 6 = Saturday."""
    return (_to_date(value).weekday() + 1) % 7


def start_of_week(value: CivilDate) -> CivilDate:
    """The Monday of the date's week (weeks start on Monday)."""
    return add_days(value, -((weekday(value) + 6) % 7))


def start_of_month(value: CivilDate) -> CivilDate:
    return f"{value[:7]}-01"


def civil_date(year: int, month: int, day: int) -> CivilDate | None:
    """Builds a civil date from parts, or None if it doesn't exist."""
    text = f"{year:04d}-{month:02d}-{day:02d}"
    return text if is_civil_date(text) else None
