"""Timestamps as the TS server wrote them: `Date.toISOString()` (UTC, milliseconds, trailing Z)."""

from __future__ import annotations

from datetime import UTC, datetime


def iso_ms(moment: datetime) -> str:
    moment = moment.astimezone(UTC) if moment.tzinfo else moment.replace(tzinfo=UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def epoch_ms(moment: datetime) -> float:
    return moment.timestamp() * 1000
