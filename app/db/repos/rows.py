"""Shared pieces of the repository layer: value conversion for what asyncpg returns, and row checks on read.

asyncpg already decodes jsonb to Python objects, uuid to `str`, bigint to `int`, timestamptz to aware UTC `datetime`
and `numeric` to `Decimal`; the helpers here cover the rest. Repos turn `asyncpg.Record` rows into frozen dataclasses.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal
from enum import Enum
from typing import Any

#: Any JSON value (jsonb columns) and a JSON object (jsonb columns that always hold an object).
JsonValue = Any
JsonObject = dict[str, Any]


class RowShapeError(Exception):
    """A row that does not have the shape the repo expects (never echoes row content)."""

    def __init__(self, table: str, detail: str) -> None:
        super().__init__(f"Unexpected {table} row shape: {detail}")


def enum_value(value: Any) -> Any:
    """The wire string of a `StrEnum`/`Enum` member, or the value itself (repos accept either for Role, Outcome, ...)."""
    return value.value if isinstance(value, Enum) else value


def big_id(value: Any) -> int:
    """`bigint` identity columns: far below 2**53 so the ids stay exact when they reach JSON."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int | str)
        or not str(value).isascii()
        or not str(value).isdigit()
    ):
        raise RowShapeError("(row)", "id: not a whole number")
    number = int(value)
    if number > 2**53 - 1:
        raise RowShapeError("(row)", "id: id exceeds the safe integer range")
    return number


def to_number(value: Any) -> int | float:
    """`numeric` columns (Decimal, or text from `::text`) as a number: an int when whole, like JS `Number(...)`."""
    if isinstance(value, bool) or not isinstance(value, Decimal | str | int | float):
        raise RowShapeError("(row)", "not a number")
    try:
        number = float(value)
    except ValueError:
        raise RowShapeError("(row)", "not a finite number") from None
    if not math.isfinite(number):
        raise RowShapeError("(row)", "not a finite number")
    return int(number) if number.is_integer() else number


def returned_row[T](table: str, rows: Sequence[T]) -> T:
    """The row from an `INSERT ... RETURNING` that always returns one."""
    if not rows:
        raise RowShapeError(table, "the statement returned no row") from None
    return rows[0]


def affected(status: str) -> int:
    """The row count in an asyncpg command status such as `DELETE 3` or `UPDATE 0`."""
    return int(status.rsplit(" ", 1)[-1])


def check_limit(limit: int, maximum: int = 1_000) -> int:
    """Positive integer for LIMIT, validated before it reaches SQL."""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > maximum:
        raise ValueError(f"limit must be an integer from 1 to {maximum}")
    return limit
