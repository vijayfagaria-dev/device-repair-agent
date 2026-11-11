"""outbox: one delivery row per record revision and target (D17), written in the record's transaction.

Delivery policy (backoff, leases, per-session ordering, dead-lettering) belongs to the worker (P7-T03).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app.db.tx import Queryable, Tx

from .rows import affected, big_id, check_limit

#: The one delivery target: the configured record webhook (RECORD_WEBHOOK_URL, D17).
WEBHOOK_TARGET = "webhook"

OUTBOX_STATUSES = ("pending", "sending", "delivered", "dead")


@dataclass(frozen=True, slots=True)
class OutboxEntry:
    id: int
    session_id: str
    revision: int
    target: str
    status: str
    attempts: int
    next_attempt_at: datetime
    last_error: str | None
    created_at: datetime
    delivered_at: datetime | None


COLUMNS = """id, session_id AS "sessionId", revision, target, status, attempts, next_attempt_at AS "nextAttemptAt",
  last_error AS "lastError", created_at AS "createdAt", delivered_at AS "deliveredAt\""""


def _entry(row: asyncpg.Record) -> OutboxEntry:
    return OutboxEntry(
        id=big_id(row["id"]),
        session_id=row["sessionId"],
        revision=row["revision"],
        target=row["target"],
        status=row["status"],
        attempts=row["attempts"],
        next_attempt_at=row["nextAttemptAt"],
        last_error=row["lastError"],
        created_at=row["createdAt"],
        delivered_at=row["deliveredAt"],
    )


async def insert_outbox(
    db: Queryable, *, session_id: str, revision: int, target: str, next_attempt_at: datetime | None = None
) -> OutboxEntry:
    """Queues a delivery. Fails with 23503 if the record revision doesn't exist, 23505 if it is already queued."""
    row = await db.fetchrow(
        f"""INSERT INTO outbox (session_id, revision, target, next_attempt_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
     RETURNING {COLUMNS}""",
        session_id,
        revision,
        target,
        next_attempt_at,
    )
    assert row is not None
    return _entry(row)


#: Deliverable = not finished, and no earlier revision of the same session and target is still unfinished (D17: rev n+1
#: waits until rev n is delivered or dead, so a consumer never sees an older revision after a newer one). `sending`
#: counts as unfinished, so a revision leased by one worker holds back the next one for every worker.
DELIVERABLE = """outbox.status IN ('pending', 'sending')
  AND NOT EXISTS (
    SELECT 1 FROM outbox earlier
    WHERE earlier.session_id = outbox.session_id AND earlier.target = outbox.target
      AND earlier.revision < outbox.revision AND earlier.status IN ('pending', 'sending')
  )"""


async def claim_due_outbox(tx: Tx, *, now: datetime, limit: int) -> list[OutboxEntry]:
    """
    Locks and returns deliverable rows (see above) that are due at `now`, oldest due first. A `sending` row whose lease
    (its next attempt time) has passed is due again. FOR UPDATE SKIP LOCKED: concurrent claimers never get the same
    row. The claim lasts until the transaction ends.
    """
    rows = await tx.fetch(
        f"""SELECT {COLUMNS} FROM outbox
     WHERE {DELIVERABLE} AND next_attempt_at <= $1
     ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED""",
        now,
        check_limit(limit),
    )
    return [_entry(r) for r in rows]


async def reclaim_outbox_leases(db: Queryable) -> int:
    """
    Boot recovery (P8-T01): every row a previous process left `sending` goes back to `pending`, due now. A lease normally
    expires by itself, but a restarted process shouldn't wait for it. If an old instance is still alive during a
    deploy overlap it may deliver the same row too: harmless, because the receiver stores an idempotency key once.
    """
    status = await db.execute("UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE status = 'sending'")
    return affected(status)


async def earliest_outbox_due_at(db: Queryable) -> datetime | None:
    """When the next deliverable row is due (None for none): the worker sleeps until then (D09: no polling)."""
    due = await db.fetchval(f"SELECT min(next_attempt_at) AS due FROM outbox WHERE {DELIVERABLE}")
    return due


async def save_outbox(
    db: Queryable,
    *,
    id: int,
    status: str,
    attempts: int,
    next_attempt_at: datetime,
    last_error: str | None,
    delivered_at: datetime | None,
) -> OutboxEntry | None:
    """Writes the delivery state. Returns the stored row, or None if there is no such row."""
    row = await db.fetchrow(
        f"""UPDATE outbox SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, delivered_at = $6 WHERE id = $1
     RETURNING {COLUMNS}""",
        id,
        status,
        attempts,
        next_attempt_at,
        last_error,
        delivered_at,
    )
    return _entry(row) if row else None


async def list_outbox(db: Queryable, session_id: str) -> list[OutboxEntry]:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM outbox WHERE session_id = $1 ORDER BY revision, target", session_id)
    return [_entry(r) for r in rows]
