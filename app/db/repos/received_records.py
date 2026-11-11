"""received_records: the stub receiver's dedup table (P7-T04). The same Idempotency-Key is stored once."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from app.db.tx import Queryable


@dataclass(frozen=True, slots=True)
class ReceivedRecord:
    idempotency_key: str
    payload: Any
    first_received_at: datetime
    last_received_at: datetime
    times_received: int


COLUMNS = """idempotency_key AS "idempotencyKey", payload, first_received_at AS "firstReceivedAt",
  last_received_at AS "lastReceivedAt", times_received AS "timesReceived\""""


def _received(row: asyncpg.Record) -> ReceivedRecord:
    return ReceivedRecord(
        idempotency_key=row["idempotencyKey"],
        payload=row["payload"],
        first_received_at=row["firstReceivedAt"],
        last_received_at=row["lastReceivedAt"],
        times_received=row["timesReceived"],
    )


async def upsert_received_record(db: Queryable, *, idempotency_key: str, payload: Any) -> ReceivedRecord:
    """Stores the first delivery of a key; a repeat only bumps the counter and last time (the first payload is kept)."""
    row = await db.fetchrow(
        f"""INSERT INTO received_records (idempotency_key, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       times_received = received_records.times_received + 1,
       last_received_at = now()
     RETURNING {COLUMNS}""",
        idempotency_key,
        payload,
    )
    assert row is not None
    return _received(row)


async def list_received_records(db: Queryable) -> list[ReceivedRecord]:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM received_records ORDER BY first_received_at, idempotency_key")
    return [_received(r) for r in rows]
