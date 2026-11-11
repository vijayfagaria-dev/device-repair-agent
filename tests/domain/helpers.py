"""Builders for domain tests: candidates, resolved field sets and a deterministic PRNG for property/fuzz tests."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.conflicts import Candidate, ResolvedField
from app.domain.fields import RECORD_FIELD_IDS

_seq = itertools.count(1)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def candidate(source: str, status: str, normalized: Any, **extra: Any) -> Candidate:
    """A candidate with an increasing seq (call order = commit order), collected one second apart."""
    seq = next(_seq)
    fields: dict[str, Any] = {
        "source": source,
        "seq": seq,
        "collected_at": _iso(datetime(2026, 11, 7, 4, 30, 0, tzinfo=UTC) + timedelta(seconds=seq)),
        "status": status,
        "normalized": normalized,
        "user_confirmed": False,
    }
    fields.update(extra)
    return Candidate(**fields)


def valid(source: str, value: Any, **extra: Any) -> Candidate:
    return candidate(source, "valid", value, **extra)


def resolved(status: str, value: Any = None, source: str | None = None) -> ResolvedField:
    """One resolved field with the given status (a value is required for valid/unverified)."""
    present = status != "missing"
    return ResolvedField(
        value=value if status in ("valid", "unverified") else None,
        source=(source or "chat") if present else None,
        collected_at="2026-11-07T04:31:00.000Z" if present else None,
        status=status,
        conflict=None,
    )


FILE = {"fileId": "fInvoice000001", "mime": "application/pdf", "size": 18233, "sha256": "a" * 64}
PHOTO = {"fileId": "fPhoto00000001", "mime": "image/jpeg", "size": 52011, "sha256": "b" * 64}

# A valid normalized value for every record field (what the validators produce).
VALID_VALUES: dict[str, Any] = {
    "deviceType": "smartphone",
    "deviceModel": {"brand": "Apple", "model": "iPhone 14 Pro"},
    "problemDescription": {
        "summary": "Screen flickers and goes black after a drop",
        "verbatim": "the screen flickers and then goes black, it started after I dropped it",
    },
    "problemStartedAt": {"date": "2026-11-03", "precision": "day", "spoken": "last Tuesday"},
    "urgency": {"level": "high", "reason": "need it for work"},
    "serialNumber": {"kind": "imei", "value": "352099001761481"},
    "purchaseInvoice": FILE,
    "serviceCentre": {"id": "blr-koramangala", "name": "Koramangala Demo Repair Centre", "city": "Bengaluru"},
    "email": "asha.rao@example.com",
    "additionalPhotos": [PHOTO],
    "additionalNotes": "Please call before visiting.",
}

_CHAT_SOURCED = {"serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"}


def all_valid(overrides: dict[str, ResolvedField] | None = None) -> dict[str, ResolvedField]:
    """Every field valid, except the overrides."""
    overrides = overrides or {}
    return {
        i: overrides.get(i) or resolved("valid", VALID_VALUES[i], "chat" if i in _CHAT_SOURCED else "call")
        for i in RECORD_FIELD_IDS
    }


_M = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M


class Prng:
    """Mulberry32, bit-for-bit the same stream as the TS test helper for the same seed."""

    def __init__(self, seed: int) -> None:
        self._state = seed & _M

    def next(self) -> float:
        self._state = (self._state + 0x6D2B79F5) & _M
        t = self._state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _M
        return ((t ^ (t >> 14)) & _M) / 4294967296

    def int(self, maximum: int) -> int:
        return int(self.next() * maximum)

    def pick[T](self, items: list[T] | tuple[T, ...]) -> T:
        return items[int(self.next() * len(items))]

    def chance(self, p: float) -> bool:
        return self.next() < p


def prng(seed: int) -> Prng:
    return Prng(seed)
