"""The session snapshot a command handler sees (D11 step 1).

Everything about one session that decisions depend on, read inside the command's transaction after the session row
lock, so it can't change underneath the handler.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, TypedDict

from app.db.repos.calls import Call, list_calls
from app.db.repos.field_candidates import FieldCandidate, list_field_candidates
from app.db.repos.files import StoredFile
from app.db.repos.input_requests import StoredInputRequest, list_input_requests
from app.db.repos.records import RevisionHash
from app.db.repos.sessions import Session
from app.db.repos.timers import Timer, list_timers
from app.db.tx import Queryable
from app.domain.conflicts import Candidate, ResolvedField, resolve_field
from app.domain.fields import RECORD_FIELD_IDS, is_field_id
from app.metrics.usage import SessionCost

from .timeutil import iso_ms


@dataclass(frozen=True, slots=True)
class HistoryFacts:
    """Facts about the session's event history that decisions need, read in the same statement as the last seq."""

    #: `chat.message` events so far (agent and user): the record's engagement.chatMessages.
    chat_messages: int = 0
    #: The `noCallStart` deadline passed without a call: the chat planner runs the flow in chat (PD10, P4-T04).
    chat_started: bool = False
    #: The planner already said it has nothing more it can ask (`chat.stalled`), so it doesn't say it again.
    chat_stalled: bool = False
    #: The seq of the latest `session.reopened` event (0 for none): a "Yes" before it no longer confirms (D16, P7-T05).
    last_reopened_seq: int = 0


class _Unset:
    """`latest_record` not loaded (TS `undefined`), as opposed to None for "no record yet"."""

    _instance: _Unset | None = None

    def __new__(cls) -> _Unset:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = _Unset()


class SnapshotExtras(TypedDict, total=False):
    """Reads only some commands need, loaded by their `prepare` step inside the same transaction."""

    files: list[StoredFile]
    cost: SessionCost
    #: The latest record revision's number and content hash, or None for none (the dedup check, P7-T02).
    latest_record: RevisionHash | None


@dataclass(frozen=True, slots=True)
class Snapshot:
    session: Session
    #: The last event seq so far (0 for none); the command's events continue from here.
    last_seq: int
    history: HistoryFacts
    timers: list[Timer]
    #: Every input card of the session, oldest first.
    requests: list[StoredInputRequest]
    #: The append-only candidate history of every field, in insertion order.
    candidates: list[FieldCandidate]
    #: Every call of the session, oldest first (at most one without `ended_at`).
    calls: list[Call]
    #: The command's clock reading: one instant for the whole command.
    now: datetime
    files: list[StoredFile] | None = None
    cost: SessionCost | None = None
    latest_record: RevisionHash | _Unset | None = field(default=UNSET)


async def load_snapshot(db: Queryable, session: Session, now: datetime) -> Snapshot:
    """Reads the rest of the snapshot. The caller holds the session row lock (lock_session) for the transaction."""
    # One after another: a transaction is one connection, which runs one statement at a time.
    row = await db.fetchrow(
        """SELECT COALESCE(max(seq), 0)::int AS seq,
       count(*) FILTER (WHERE type = 'chat.message')::int AS chat_messages,
       COALESCE(bool_or(type = 'chat.started'), false) AS chat_started,
       COALESCE(bool_or(type = 'chat.stalled'), false) AS chat_stalled,
       COALESCE(max(seq) FILTER (WHERE type = 'session.reopened'), 0)::int AS last_reopened_seq
     FROM events WHERE session_id = $1""",
        session.id,
    )
    timers = await list_timers(db, session.id)
    requests = await list_input_requests(db, session.id)
    candidates = await list_field_candidates(db, session.id)
    calls = await list_calls(db, session.id)
    return Snapshot(
        session=session,
        last_seq=int(row["seq"]) if row else 0,
        history=HistoryFacts(
            chat_messages=int(row["chat_messages"]) if row else 0,
            chat_started=bool(row and row["chat_started"]),
            chat_stalled=bool(row and row["chat_stalled"]),
            last_reopened_seq=int(row["last_reopened_seq"]) if row else 0,
        ),
        timers=timers,
        requests=requests,
        candidates=candidates,
        calls=calls,
        now=now,
    )


def _to_domain_candidate(row: FieldCandidate) -> Candidate:
    """A stored candidate as the conflict resolver takes it (P2-T05)."""
    return Candidate(
        source=row.source,  # type: ignore[arg-type]
        seq=row.event_seq,
        collected_at=iso_ms(row.collected_at),
        status=row.status,  # type: ignore[arg-type]
        normalized=row.normalized,
        user_confirmed=row.user_confirmed,
    )


def resolve_fields(candidates: Any) -> dict[str, ResolvedField]:
    """The effective value of every record field, computed from the candidate history (never stored, architecture section 4)."""
    by_field: dict[str, list[Candidate]] = {}
    for row in candidates:
        if not is_field_id(row.field):
            continue  # control fields (e.g. submitConfirmation) aren't record fields
        by_field.setdefault(row.field, []).append(_to_domain_candidate(row))
    return {field_id: resolve_field(field_id, by_field.get(field_id, [])) for field_id in RECORD_FIELD_IDS}
