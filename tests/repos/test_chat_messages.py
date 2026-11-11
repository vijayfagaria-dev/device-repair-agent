from __future__ import annotations

from datetime import datetime

import asyncpg
import pytest

from app.db.repos.chat_messages import insert_chat_message, list_chat_messages
from tests.repos.seed import seed_event, seed_session


async def test_insert_chat_message_stores_the_message_with_an_optional_request_id(db) -> None:
    id = await seed_session(db.pool)
    seq = await seed_event(db.pool, id)
    msg = await insert_chat_message(db.pool, id=f"m_{id}_1", session_id=id, event_seq=seq, role="agent", text="Hello")
    assert (msg.id, msg.session_id, msg.event_seq, msg.role, msg.text, msg.request_id) == (
        f"m_{id}_1",
        id,
        seq,
        "agent",
        "Hello",
        None,
    )
    assert isinstance(msg.created_at, datetime)
    reply = await insert_chat_message(
        db.pool, id=f"m_{id}_2", session_id=id, event_seq=seq, role="user", text="AB12", request_id="req_serial_1"
    )
    assert reply.request_id == "req_serial_1"
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_chat_message(db.pool, id=f"m_{id}_1", session_id=id, event_seq=seq, role="user", text="dup")
    assert err.value.sqlstate == "23505"


async def test_list_chat_messages_returns_the_sessions_messages_in_event_order(db) -> None:
    id = await seed_session(db.pool)
    first = await seed_event(db.pool, id)
    second = await seed_event(db.pool, id)
    # Inserted out of order: the list follows event_seq, not insertion.
    await insert_chat_message(db.pool, id=f"m_{id}_b", session_id=id, event_seq=second, role="user", text="second")
    await insert_chat_message(db.pool, id=f"m_{id}_a", session_id=id, event_seq=first, role="agent", text="first")
    assert [m.text for m in await list_chat_messages(db.pool, id)] == ["first", "second"]
    assert await list_chat_messages(db.pool, await seed_session(db.pool)) == []
