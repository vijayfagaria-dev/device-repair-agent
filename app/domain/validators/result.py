"""The common validator result (P2-T02/T03): code decides whether a value is acceptable, never the LLM.
`error` is one short sentence that can be spoken by the agent or shown under a chat card."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True, slots=True)
class ValidationResult[T]:
    """status "valid" carries `normalized`; "invalid" carries `error`; "skipped" is an optional field the user
    explicitly skipped (the card's Skip sends null)."""

    status: Literal["valid", "invalid", "skipped"]
    normalized: T | None = None
    error: str | None = None


def valid[T](normalized: T) -> ValidationResult[T]:
    return ValidationResult("valid", normalized=normalized)


def invalid(error: str) -> ValidationResult[Any]:
    return ValidationResult("invalid", error=error)


def skipped() -> ValidationResult[Any]:
    return ValidationResult("skipped")
