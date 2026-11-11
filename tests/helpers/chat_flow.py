"""Helpers for P4 chat-flow tests: start a session's chat the way production does (the noCallStart timer fires), answer
cards through the real SubmitChatInput handler, and read what is open.

(The TS file's ``process``/``app`` siblings, which run the server and its sockets, belong to the transport tests.)
"""

from __future__ import annotations

import binascii
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.pool import Database
from app.db.repos.files import StoredFile, insert_file
from app.db.repos.input_requests import StoredInputRequest, get_open_input_request, list_input_requests
from app.db.repos.sessions import lock_session
from app.db.repos.timers import Timer, upsert_timer
from app.db.tx import transaction
from app.session.handlers.chat_input import SubmitChatInput
from app.session.handlers.timers import TimerFired
from app.session.services import SessionServices
from tests.helpers.seed import seed_session

#: A small real PDF (magic bytes are what count).
PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
#: A 1x1 PNG.
PNG = binascii.unhexlify(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
#: A Windows executable header (MZ) renamed to .pdf.
EXE = b"MZ\x90\x00\x03\x00\x00\x00" + bytes(200)


async def start_chat(db: Database, services: SessionServices, session_id: str) -> None:
    """Fires the session's noCallStart timer now (PD10): the chat starts and the planner opens the first card."""
    await upsert_timer(
        db.pool, Timer(session_id=session_id, kind="noCallStart", due_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await services.processor.dispatch(session_id, TimerFired(kind="noCallStart", due_at=datetime.now(UTC)))


async def chat_session(db: Database, services: SessionServices) -> str:
    """A new session whose chat has started."""
    session_id = await seed_session(db.pool)
    await start_chat(db, services, session_id)
    return session_id


async def open_card(db: Database, session_id: str) -> StoredInputRequest | None:
    return await get_open_input_request(db.pool, session_id)


async def cards(db: Database, session_id: str) -> list[StoredInputRequest]:
    return await list_input_requests(db.pool, session_id)


async def answer(services: SessionServices, session_id: str, request_id: str, field: str, value: Any) -> Any:
    result = await services.processor.dispatch(
        session_id, SubmitChatInput(request_id=request_id, field=field, value=value)
    )
    return result.reply


async def answer_open(db: Database, services: SessionServices, session_id: str, field: str, value: Any) -> Any:
    """Answers whatever card is open (it must be for ``field``)."""
    open_ = await open_card(db, session_id)
    if open_ is None or open_.field != field:
        raise AssertionError(f"expected the open card to be {field}, got {open_.field if open_ else 'none'}")
    return await answer(services, session_id, open_.id, field, value)


async def store_test_file(
    db: Database,
    session_id: str,
    data: bytes = PDF,
    mime: str = "application/pdf",
    name: str = "invoice.pdf",
) -> StoredFile:
    """Stores an upload for the session directly (the HTTP endpoint is tested with the transport)."""
    async with transaction(db.pool) as tx:
        await lock_session(tx, session_id)
        return await insert_file(
            tx, id=f"f{uuid.uuid4().hex[:16]}", session_id=session_id, mime=mime, data=data, original_name=name
        )


def _five_days_ago() -> str:
    # Five days ago (IST is at most a day ahead of UTC), so it is never "in the future" whatever the clock says.
    return (datetime.now(UTC) - timedelta(days=5)).strftime("%Y-%m-%d")


#: Valid chat answers for every card the planner can open, by field (file cards need a stored file).
ANSWERS: dict[str, Any] = {
    "deviceType": "smartphone",
    "deviceModel": "Samsung Galaxy S23",
    "problemDescription": "The screen flickers and then goes black after a minute",
    "problemStartedAt": _five_days_ago(),
    "urgency": "high",
    "serialNumber": "35-209900-176148-1",
    "serviceCentre": "blr-koramangala",
    "email": "asha.rao@example.com",
    "additionalPhotos": None,
    "additionalNotes": None,
}


async def session_at_field(db: Database, services: SessionServices, field: str) -> str:
    """A session whose chat has started and whose open card is for ``field`` (the cards before it answered validly)."""
    session_id = await chat_session(db, services)
    for _ in range(12):
        open_ = await open_card(db, session_id)
        if open_ is None:
            raise AssertionError("no open card")
        if open_.field == field:
            return session_id
        value = ANSWERS.get(open_.field)
        if open_.field == "purchaseInvoice":
            value = f"file:{(await store_test_file(db, session_id)).id}"
        await answer(services, session_id, open_.id, open_.field, value)
    raise AssertionError(f"never reached {field}")
