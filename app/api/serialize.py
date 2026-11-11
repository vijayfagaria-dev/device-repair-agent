"""JSON shaping shared by the HTTP routes: timestamps as `Date.prototype.toISOString` wrote them."""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime
from typing import Any

from pydantic.alias_generators import to_camel


def iso(moment: datetime) -> str:
    """UTC, milliseconds (truncated, as JS does), trailing Z: `2026-11-08T12:00:00.123Z`."""
    utc = moment.astimezone(UTC) if moment.tzinfo else moment.replace(tzinfo=UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def camel_dict(value: Any) -> dict[str, Any]:
    """A dataclass as a dict with camelCase keys; datetimes become ISO strings."""
    out: dict[str, Any] = {}
    for f in dataclasses.fields(value):
        item = getattr(value, f.name)
        out[to_camel(f.name)] = iso(item) if isinstance(item, datetime) else item
    return out
