"""``toMatchObject`` for Python: a recursive subset check (dicts: every expected key matches; lists: same length,
element-wise subset; everything else equality). ``ANY`` matches any value, ``any_of(type)`` any value of a type."""

from __future__ import annotations

from typing import Any


class _Any:
    def __repr__(self) -> str:
        return "ANY"


ANY: Any = _Any()


def any_of(kind: type) -> Any:
    class _AnyOf:
        def __eq__(self, other: object) -> bool:
            return isinstance(other, kind)

        def __repr__(self) -> str:
            return f"any_of({kind.__name__})"

    return _AnyOf()


def _attr(value: Any, key: str) -> Any:
    return value[key] if isinstance(value, dict) else getattr(value, key)


def matches(actual: Any, expected: Any) -> bool:
    if expected is ANY:
        return True
    if isinstance(expected, dict):
        for key, want in expected.items():
            try:
                got = _attr(actual, key)
            except (KeyError, AttributeError):
                return False
            if not matches(got, want):
                return False
        return True
    if isinstance(expected, list | tuple):
        return (
            isinstance(actual, list | tuple)
            and len(actual) == len(expected)
            and all(matches(a, e) for a, e in zip(actual, expected, strict=True))
        )
    return bool(actual == expected)


def assert_matches(actual: Any, expected: Any) -> None:
    assert matches(actual, expected), f"{actual!r} does not match {expected!r}"
