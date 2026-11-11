"""usage: the provider usage ledger. Cost math and daily counters live in app.metrics.usage; this is the data access."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

import asyncpg

from app.db.tx import Queryable

from .rows import big_id, to_number


@dataclass(frozen=True, slots=True)
class UsageEntry:
    id: int
    session_id: str
    provider: str
    kind: str
    units: int | float
    unit: str
    cost_usd: int | float
    at: datetime


COLUMNS = """id, session_id AS "sessionId", provider, kind, units, unit, cost_usd AS "costUsd", at"""


def _entry(row: asyncpg.Record) -> UsageEntry:
    return UsageEntry(
        id=big_id(row["id"]),
        session_id=row["sessionId"],
        provider=row["provider"],
        kind=row["kind"],
        units=to_number(row["units"]),
        unit=row["unit"],
        cost_usd=to_number(row["costUsd"]),
        at=row["at"],
    )


async def insert_usage(
    db: Queryable,
    *,
    session_id: str,
    provider: str,
    kind: str,
    units: float,
    unit: str,
    cost_usd: float | None = None,
    at: datetime | None = None,
) -> UsageEntry:
    cost = 0 if cost_usd is None else cost_usd
    for name, value in (("units", units), ("costUsd", cost)):
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be a finite number >= 0")
    row = await db.fetchrow(
        f"""INSERT INTO usage (session_id, provider, kind, units, unit, cost_usd, at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     RETURNING {COLUMNS}""",
        session_id,
        provider,
        kind,
        Decimal(str(units)),  # the shortest repr, as JS sends it: 212.4 stays 212.4, not 212.40000000000000568...
        unit,
        Decimal(str(cost)),
        at,
    )
    assert row is not None
    return _entry(row)


async def list_usage(db: Queryable, session_id: str) -> list[UsageEntry]:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM usage WHERE session_id = $1 ORDER BY at, id", session_id)
    return [_entry(r) for r in rows]
