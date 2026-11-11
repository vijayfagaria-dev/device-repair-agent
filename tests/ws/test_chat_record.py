"""Record visibility on /chat (P6-T03; protocol.md section 3.3 `record`, section 4 replay): the record card arrives with the
finalization (<= 1 s), in the right place in the thread, is the stored record exactly, is replayed on reconnect and after a
restart, and a later revision has its own id so the page replaces its card instead of adding a second.
(Port of server/test/ws/chatRecord.test.ts.)"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from app.db.repos.events import list_events
from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.domain.fields import FIELDS, RECORD_FIELD_IDS
from app.protocol.schemas import parse_chat_server_message
from app.session.handlers.finalize import Finalize
from tests.domain.helpers import VALID_VALUES
from tests.helpers.app import connect, start_app, wait_for
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.match import assert_matches
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.seed import seed_session
from tests.helpers.session import test_services

CHAT = {"serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"}
REQUIRED = [field for field in RECORD_FIELD_IDS if FIELDS[field].required]

Msg = dict[str, Any]


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db)


@pytest.fixture
async def server(db, services):  # type: ignore[no-untyped-def]
    running = await start_app(db, services=services)
    yield running
    await running.close()


async def collect(services: Any, id_: str, fields: list[str]) -> None:
    for field in fields:
        await services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": field,
                "source": "chat" if field in CHAT else "call",
                "raw": "x",
                "normalized": VALID_VALUES[field],
                "status": "valid",
            },
        )


class Open:
    def __init__(self, socket: Any) -> None:
        self.socket = socket

    @property
    def all(self) -> list[Msg]:
        return self.socket.messages

    async def close(self) -> None:
        await self.socket.close()


async def open_chat(id_: str, app: Any) -> Open:
    socket = connect(f"{app.ws}/chat?sessionId={id_}")
    await socket.opened
    await wait_for(lambda: any(m["type"] == "syncDone" for m in socket.messages), "syncDone", 3.0, 0.005)
    return Open(socket)


def records(messages: list[Msg]) -> list[Msg]:
    return [m for m in messages if m["type"] == "record"]


class TestTheRecordOnTheChatSocket:
    async def test_arrives_live_within_1_s_of_the_finalization_as_the_stored_record_in_the_right_place(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType", "deviceModel"])
        await services.processor.dispatch(
            id_, {"type": "Test.OpenCard", "requestId": "req_problemDescription_1", "field": "problemDescription"}
        )
        chat = await open_chat(id_, server)
        since_sync = len(chat.all)

        started = time.monotonic()
        result = await services.processor.dispatch(id_, Finalize(trigger="optOutConfirmed"))
        assert_matches(result.reply, {"finalized": True, "revision": 1, "outcome": "optedOut"})
        await wait_for(lambda: len(records(chat.all)) > 0, "the record message", 1.0, 0.005)
        assert time.monotonic() - started < 1.0

        [stored] = await list_records(db.pool, id_)
        live = chat.all[since_sync:]
        message = records(live)[0]
        assert message == {"type": "record", "id": "rec_1", "record": stored.payload}
        parse_chat_server_message(message)
        expect_sanitized_record(message["record"], FAKE_SECRET_VALUES)

        # The card the finalization closed (an opt-out closes every card; a partial session keeps its card), then the
        # record, then the closing message; the state last.
        assert [m["type"] for m in live] == ["inputCancel", "record", "message", "sessionState"]
        assert_matches(live[-1], {"status": "finalized", "outcome": "optedOut", "revision": 1})
        await chat.close()

    async def test_is_replayed_to_a_returning_page_and_a_second_tab_exactly_as_it_was_sent_live_and_never_twice(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType"])
        first = await open_chat(id_, server)
        await services.processor.dispatch(id_, Finalize(trigger="testFinalize"))
        await wait_for(lambda: len(records(first.all)) > 0, "the live record", 3.0, 0.005)

        second = await open_chat(id_, server)  # a second tab, or a reload
        assert records(second.all) == records(first.all)
        # Replay puts the record after the history and before sessionState and syncDone (section 4 step 3).
        assert [m["type"] for m in second.all][-3:] == ["record", "sessionState", "syncDone"]
        await first.close()
        await second.close()

    async def test_a_later_revision_has_its_own_id_and_is_the_only_record_a_returning_page_is_sent(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType", "deviceModel"])
        chat = await open_chat(id_, server)
        await services.processor.dispatch(id_, Finalize(trigger="testFinalize"))
        await wait_for(lambda: len(records(chat.all)) == 1, "revision 1", 3.0, 0.005)

        # The session becomes active again (what the reopen flow, P7-T05, does) and the claim is completed.
        await db.pool.execute("UPDATE sessions SET status = 'active' WHERE id = $1", id_)
        await collect(services, id_, REQUIRED)
        await services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "submitConfirmation",
                "source": "chat",
                "raw": True,
                "normalized": True,
                "status": "valid",
            },
        )
        result = await services.processor.dispatch(id_, Finalize(trigger="confirmSubmit"))
        assert_matches(result.reply, {"finalized": True, "revision": 2, "outcome": "completed"})
        await wait_for(lambda: len(records(chat.all)) == 2, "revision 2", 3.0, 0.005)

        # Distinct ids: the page's reducer replaces the card it shows; the server never re-sends rev 1 as part of rev 2.
        assert [m["id"] for m in records(chat.all)] == ["rec_1", "rec_2"]
        assert_matches(
            records(chat.all)[1]["record"],
            {"revision": 2, "outcome": "completed", "previousRevision": {"revision": 1, "outcome": "partial"}},
        )

        reload = await open_chat(id_, server)
        assert [m["id"] for m in records(reload.all)] == ["rec_2"]
        async with server.client() as client:
            listing = (await client.get(f"/api/sessions/{id_}/records")).json()
        assert [r["revision"] for r in listing["records"]] == [1, 2]
        await chat.close()
        await reload.close()

    async def test_a_reconnect_alone_does_not_reopen_a_finalized_session_it_replays_the_record_and_the_kept_card(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType"])
        await services.processor.dispatch(
            id_, {"type": "Test.OpenCard", "requestId": "req_deviceModel_1", "field": "deviceModel"}
        )
        await services.processor.dispatch(id_, Finalize(trigger="testFinalize"))
        for _ in range(3):
            chat = await open_chat(id_, server)
            requests = [m for m in chat.all if m["type"] == "inputRequest"]
            assert_matches(requests, [{"id": "req_deviceModel_1"}])  # kept open (partial)
            assert [m["id"] for m in records(chat.all)] == ["rec_1"]
            state = next(m for m in chat.all if m["type"] == "sessionState")
            assert_matches(state, {"status": "finalized", "outcome": "partial"})
            await chat.close()
        await asyncio.sleep(0.1)  # the connect-time reconcile has run
        assert (await get_session(db.pool, id_)).status == "finalized"
        assert "session.reopened" not in [e.type for e in await list_events(db.pool, id_)]
        assert len(await list_records(db.pool, id_)) == 1

    async def test_survives_a_server_restart_a_new_process_empty_hub_replays_the_same_record(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType"])
        await services.processor.dispatch(id_, Finalize(trigger="testFinalize"))
        before = await open_chat(id_, server)
        restarted = await start_app(db, services=test_services(db))
        try:
            after = await open_chat(id_, restarted)
            assert records(after.all) == records(before.all)
            assert len(records(after.all)) == 1
            await after.close()
        finally:
            await before.close()
            await restarted.close()
