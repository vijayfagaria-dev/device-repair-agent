from __future__ import annotations

from datetime import datetime

import asyncpg
import pytest

from app.db.repos.input_requests import (
    get_input_request,
    get_open_input_request,
    insert_input_request,
    list_input_requests,
    save_input_request,
)
from tests.repos.seed import seed_session

SPEC = {"kind": "text", "label": "Serial number", "required": True, "pattern": "^[A-Z0-9]{8,}$"}


async def test_insert_input_request_stores_the_card_spec_queued_by_default(db) -> None:
    id = await seed_session(db.pool)
    req = await insert_input_request(db.pool, session_id=id, id="req_serial_1", field="serialNumber", spec=SPEC)
    assert (req.session_id, req.id, req.field, req.spec, req.status, req.attempts) == (
        id,
        "req_serial_1",
        "serialNumber",
        SPEC,
        "queued",
        0,
    )
    assert isinstance(req.created_at, datetime)
    opened = await insert_input_request(db.pool, session_id=id, id="req_email_1", field="email", spec={}, status="open")
    assert opened.status == "open"


async def test_get_input_request_finds_a_card_by_session_and_id(db) -> None:
    id = await seed_session(db.pool)
    await insert_input_request(db.pool, session_id=id, id="req_a_1", field="a", spec=SPEC)
    found = await get_input_request(db.pool, id, "req_a_1")
    assert found is not None and found.spec == SPEC
    assert await get_input_request(db.pool, id, "req_missing") is None
    assert await get_input_request(db.pool, await seed_session(db.pool), "req_a_1") is None


async def test_get_open_input_request_returns_the_one_open_card_a_second_open_card_is_rejected(db) -> None:
    id = await seed_session(db.pool)
    assert await get_open_input_request(db.pool, id) is None
    await insert_input_request(db.pool, session_id=id, id="req_a_1", field="a", spec={})
    await insert_input_request(db.pool, session_id=id, id="req_b_1", field="b", spec={}, status="open")
    opened = await get_open_input_request(db.pool, id)
    assert opened is not None and opened.id == "req_b_1"
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_input_request(db.pool, session_id=id, id="req_c_1", field="c", spec={}, status="open")
    assert err.value.sqlstate == "23505"


async def test_list_input_requests_returns_the_sessions_cards_in_creation_order(db) -> None:
    id = await seed_session(db.pool)
    for n in (1, 2, 3):
        await insert_input_request(db.pool, session_id=id, id=f"req_f_{n}", field="f", spec={"n": n})
    assert [r.id for r in await list_input_requests(db.pool, id)] == ["req_f_1", "req_f_2", "req_f_3"]


async def test_save_input_request_updates_status_attempts_and_updated_at_none_for_an_unknown_card(db) -> None:
    id = await seed_session(db.pool)
    created = await insert_input_request(db.pool, session_id=id, id="req_a_1", field="a", spec={})
    saved = await save_input_request(db.pool, session_id=id, id="req_a_1", status="answered", attempts=2)
    assert saved is not None
    assert (saved.status, saved.attempts, saved.created_at) == ("answered", 2, created.created_at)
    assert saved.updated_at >= created.updated_at
    assert await save_input_request(db.pool, session_id=id, id="req_nope", status="answered", attempts=1) is None
