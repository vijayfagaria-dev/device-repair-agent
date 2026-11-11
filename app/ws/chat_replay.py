"""The replay a /chat connection starts with (protocol.md section 4 step 3), read from the database.

Consistency with the live stream: the caller subscribes to the hub BEFORE calling this. Everything is read in one
read-only snapshot (one connection, REPEATABLE READ), so the history, the open card, the record and the session state
all reflect exactly the events up to `last_seq`. Every event is then in exactly one of: the replay (seq <= last_seq) or
the buffered live updates (seq > last_seq, which the socket filters by seq), and the thread keeps commit order: a card
opened after last_seq arrives live, after the messages committed before it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repos.chat_messages import list_chat_messages
from app.db.repos.input_requests import get_open_input_request
from app.db.repos.records import get_latest_record
from app.db.repos.sessions import get_session
from app.db.repos.transcript_lines import list_transcript_lines
from app.db.tx import transaction

from .chat_projection import (
    ChatWire,
    chat_message_wire,
    input_request_wire,
    record_wire,
    session_state_wire,
    transcript_wire,
)


@dataclass(slots=True)
class Replay:
    #: The last event seq the history reflects (syncDone.lastSeq).
    last_seq: int
    #: Chat messages and final transcript lines, merged in event order (step 3.1).
    history: list[ChatWire]
    #: The open card, if any (3.2).
    open_request: ChatWire | None
    #: The latest record revision, if any (3.3).
    record: ChatWire | None
    #: The session as read for this replay (3.4).
    state: ChatWire


async def load_replay(pool: Any, session_id: str) -> Replay:
    # One statement at a time: a transaction is one connection.
    async with transaction(pool, snapshot=True) as tx:
        row = await tx.fetchrow(
            "SELECT COALESCE(max(seq), 0)::int AS seq FROM events WHERE session_id = $1", session_id
        )
        last_seq = int(row["seq"]) if row else 0
        messages = await list_chat_messages(tx, session_id)
        lines = await list_transcript_lines(tx, session_id)
        open_request = await get_open_input_request(tx, session_id)
        record = await get_latest_record(tx, session_id)
        session = await get_session(tx, session_id)
    if session is None:
        raise RuntimeError("session not found during replay")

    # Both lists are already in event order; merge them. The snapshot holds nothing newer than last_seq, and the filter
    # keeps that true even if a caller ever reads outside one.
    items: list[tuple[int, ChatWire]] = [
        (m.event_seq, chat_message_wire(id=m.id, role=m.role, text=m.text, request_id=m.request_id))
        for m in messages
        if m.event_seq <= last_seq
    ]
    items += [
        (line.event_seq, transcript_wire(id=line.id, role=line.role, text=line.text))
        for line in lines
        if line.event_seq <= last_seq
    ]
    items.sort(key=lambda item: item[0])  # stable: equal seqs keep their (messages, then lines) order
    return Replay(
        last_seq=last_seq,
        history=[message for _, message in items],
        open_request=(
            input_request_wire(id=open_request.id, field=open_request.field, spec=open_request.spec)
            if open_request
            else None
        ),
        record=record_wire(record.revision, record.payload) if record else None,
        state=session_state_wire(session),
    )
