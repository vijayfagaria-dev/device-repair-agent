"""Value conversion and checks used by the repos (the TS rows.test.ts, adapted: rows are dataclasses, not zod objects)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.db.repos.rows import (
    RowShapeError,
    affected,
    big_id,
    check_limit,
    returned_row,
    to_number,
)


def test_big_id_and_to_number_convert_pgs_bigint_and_numeric_values() -> None:
    assert big_id("42") == 42
    assert big_id(7) == 7
    assert to_number("0.00012345") == 0.00012345
    assert to_number(Decimal("2")) == 2
    assert isinstance(to_number("2"), int)  # whole numbers stay ints, like JS Number("2") in JSON


def test_a_wrong_shape_raises_row_shape_error() -> None:
    with pytest.raises(RowShapeError):
        big_id("9007199254740993")
    with pytest.raises(RowShapeError):
        big_id("-1")
    with pytest.raises(RowShapeError):
        to_number("NaN")
    with pytest.raises(RowShapeError):
        to_number("not a number")
    with pytest.raises(RowShapeError) as err:
        to_number(None)
    assert str(err.value).startswith("Unexpected (row) row shape")


def test_returned_row_and_affected() -> None:
    assert returned_row("t", [1, 2]) == 1
    with pytest.raises(RowShapeError, match="returned no row"):
        returned_row("t", [])
    assert affected("DELETE 3") == 3
    assert affected("UPDATE 0") == 0


def test_check_limit_accepts_1_to_max_integers_only() -> None:
    assert check_limit(1) == 1
    assert check_limit(1000) == 1000
    for bad in (0, -1, 1.5, 1001, float("nan")):
        with pytest.raises(ValueError):
            check_limit(bad)  # type: ignore[arg-type]
