"""Restart chaos tests (P8-T03, MH5 "survives a restart"): the real server process kills itself with SIGKILL at a named
failpoint, then a new process starts on the same database. After each: the data is there, the next card is open where it
should be, exactly one revision exists per finalization, and the receiver holds exactly one stored record (a redelivery
only raises its counter). Failpoints, not sleeps: the process dies at the point, the test waits for it.
(Port of server/test/chaos/restart.test.ts.)
"""

from __future__ import annotations

import contextlib
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.db.pool import Database
from app.db.repos.calls import list_calls
from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.outbox import list_outbox
from app.db.repos.received_records import ReceivedRecord, list_received_records
from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.session.handlers.call import StartCall
from app.session.services import SessionServices
from tests.chaos.harness import (
    CHAOS_ORIGIN,
    Exit,
    Spawned,
    create_chaos_database,
    exits_within,
    finalize_request,
    spawn_server,
    until,
)
from tests.helpers.app import TestSocket, connect
from tests.helpers.chat_flow import ANSWERS, answer, open_card, session_at_field
from tests.helpers.session import test_services

SIGKILLED = Exit(code=None, signal="SIGKILL")


class Chaos:
    def __init__(self, url: str, db: Database, services: SessionServices) -> None:
        self.url = url
        self.db = db
        self.services = services  # seeds state in-process, through the same handlers the server runs
        self.spawned: list[Spawned] = []

    async def server(self, **options: Any) -> Spawned:
        s = await spawn_server(self.url, **options)
        self.spawned.append(s)
        return s

    async def restart(self) -> tuple[Spawned, str]:
        """A new process on the same database; its address once it listens (recovery has run)."""
        s = await self.server()
        return s, await s.listening()

    async def received(self, session_id: str) -> list[ReceivedRecord]:
        return [r for r in await list_received_records(self.db.pool) if r.idempotency_key.startswith(session_id)]

    async def revisions(self, session_id: str) -> list[int]:
        return [r.revision for r in await list_records(self.db.pool, session_id)]

    async def event_types(self, session_id: str) -> list[str]:
        return [e.type for e in await list_events(self.db.pool, session_id)]


# A database of its own per test: a row one test leaves behind (an undelivered record, say) must never be picked up, and
# trip a failpoint, in the next test's server.
@pytest.fixture
async def chaos(test_database_url: str) -> AsyncIterator[Chaos]:
    database = await create_chaos_database(test_database_url)
    ctx = Chaos(database.url, database.db, test_services(database.db, planner=True))
    try:
        yield ctx
    finally:
        for s in ctx.spawned:
            await s.kill()
        await database.drop()


async def replayed(socket: TestSocket) -> None:
    async def done() -> bool:
        return any(m.get("type") == "syncDone" for m in socket.messages if isinstance(m, dict))

    await until(done, "the replay")


def ws_url(address: str, session_id: str) -> str:
    return f"{address.replace('http', 'ws', 1)}/chat?sessionId={session_id}"


class TestKillAtAFailpointThenRestart:
    async def test_1_right_after_a_chat_input_commit_the_answer_is_kept_and_the_restart_opens_the_next_card(
        self, chaos: Chaos
    ):
        db = chaos.db
        sid = await session_at_field(db, chaos.services, "serialNumber")
        card = await open_card(db, sid)
        assert card is not None
        first = await chaos.server(failpoints="commit.after.SubmitChatInput")
        address = await first.listening()
        chat = connect(ws_url(address, sid), origin=CHAOS_ORIGIN)
        await chat.opened
        await replayed(chat)
        await chat.send(
            json.dumps(
                {
                    "type": "inputResponse",
                    "requestId": card.id,
                    "field": "serialNumber",
                    "value": ANSWERS["serialNumber"],
                }
            )
        )
        assert await exits_within(first) == SIGKILLED

        # The commit survived; its reaction (the planner opening the next card) never ran.
        candidates = await list_field_candidates(db.pool, sid, "serialNumber")
        assert len(candidates) == 1
        assert candidates[0].status == "valid" and candidates[0].source == "chat"
        assert await open_card(db, sid) is None

        s, again = await chaos.restart()
        reopened = await open_card(db, sid)  # reconciled before the server listened
        assert reopened is not None and reopened.field == "purchaseInvoice"
        assert s.log("recovery: active sessions reconciled") is not None
        # A returning page sees the answer and the card, once.
        page = connect(ws_url(again, sid), origin=CHAOS_ORIGIN)
        await page.opened
        await replayed(page)
        messages = [m for m in page.messages if isinstance(m, dict)]
        assert [m["id"] for m in messages if m["type"] == "inputRequest"] == ["req_purchaseInvoice_1"]
        assert any(m["type"] == "message" and m.get("text") == ANSWERS["serialNumber"] for m in messages)
        assert len(await list_field_candidates(db.pool, sid, "serialNumber")) == 1
        await page.close()
        assert (await s.stop()).code == 0

    async def test_2_after_call_ended_committed_and_before_the_next_card_the_restart_opens_it_and_the_call_ends_once(
        self, chaos: Chaos
    ):
        db = chaos.db
        # The call was running when the process died; the card it was on had just been answered (its reaction never ran).
        sid = await session_at_field(db, chaos.services, "serialNumber")
        card = await open_card(db, sid)
        assert card is not None
        await answer(test_services(db, planner=False), sid, card.id, "serialNumber", ANSWERS["serialNumber"])
        await chaos.services.processor.dispatch(sid, StartCall(call_id=f"c{sid[:8]}"))
        assert await open_card(db, sid) is None

        # Boot recovery ends the call (a commit), and the process dies before anything that follows a commit.
        first = await chaos.server(failpoints="commit.after.EndCall")
        assert await exits_within(first) == SIGKILLED
        assert (await list_calls(db.pool, sid))[0].end_reason == "server_restart"
        assert await open_card(db, sid) is None  # the next card is missing
        session = await get_session(db.pool, sid)
        assert session is not None and session.active_call_id is None

        s, _ = await chaos.restart()
        reopened = await open_card(db, sid)
        assert reopened is not None and reopened.field == "purchaseInvoice"
        assert [t for t in await chaos.event_types(sid) if t == "call.ended"] == ["call.ended"]
        dangling = s.log("recovery: dangling calls ended")
        assert dangling is not None and dangling["count"] == 0  # nothing left to end
        assert len(await list_calls(db.pool, sid)) == 1
        assert (await s.stop()).code == 0

    async def test_3_in_the_middle_of_a_finalization_before_commit_nothing_was_produced_and_finalizing_again_makes_one_revision(
        self, chaos: Chaos
    ):
        db = chaos.db
        sid = await session_at_field(db, chaos.services, "submitConfirmation")
        first = await chaos.server(failpoints="finalize.beforeCommit")
        address = await first.listening()
        with contextlib.suppress(Exception):
            await finalize_request(address, sid)  # the connection dies with the process
        assert await exits_within(first) == SIGKILLED
        assert await chaos.revisions(sid) == []
        assert await list_outbox(db.pool, sid) == []
        session = await get_session(db.pool, sid)
        assert session is not None and session.status == "active" and session.current_revision == 0
        assert [t for t in await chaos.event_types(sid) if t == "session.finalized"] == []
        card = await open_card(db, sid)  # the user's card is still there
        assert card is not None and card.field == "submitConfirmation"

        s, again = await chaos.restart()
        assert (await finalize_request(again, sid)).status_code == 200
        assert await chaos.revisions(sid) == [1]

        async def delivered() -> bool:
            return len(await chaos.received(sid)) == 1

        await until(delivered, "delivery")
        record = (await chaos.received(sid))[0]
        assert record.idempotency_key == f"{sid}:1" and record.times_received == 1
        assert (await finalize_request(again, sid)).status_code == 200  # a repeat is a no-op
        assert await chaos.revisions(sid) == [1]
        assert (await s.stop()).code == 0

    async def test_4_after_a_finalization_committed_before_delivery_the_restart_delivers_it_once(self, chaos: Chaos):
        db = chaos.db
        sid = await session_at_field(db, chaos.services, "submitConfirmation")
        first = await chaos.server(failpoints="finalize.afterCommit")
        address = await first.listening()
        with contextlib.suppress(Exception):
            await finalize_request(address, sid)
        assert await exits_within(first) == SIGKILLED
        # Durable: the record, the outbox row and the session; nothing delivered.
        assert await chaos.revisions(sid) == [1]
        outbox = await list_outbox(db.pool, sid)
        assert [(o.revision, o.status, o.attempts) for o in outbox] == [(1, "pending", 0)]
        assert await chaos.received(sid) == []
        session = await get_session(db.pool, sid)
        assert session is not None
        assert (session.status, session.outcome, session.current_revision) == ("finalized", "completed", 1)

        s, _ = await chaos.restart()

        async def delivered() -> bool:
            return len(await chaos.received(sid)) == 1

        await until(delivered, "delivery after the restart")
        record = (await chaos.received(sid))[0]
        assert record.idempotency_key == f"{sid}:1" and record.times_received == 1
        assert record.payload["revision"] == 1 and record.payload["sessionId"] == sid

        async def marked() -> bool:
            return (await list_outbox(db.pool, sid))[0].status == "delivered"

        await until(marked, "marked delivered")
        assert await chaos.revisions(sid) == [1]
        assert (await s.stop()).code == 0

    async def test_5_after_the_receiver_got_the_post_before_it_was_marked_delivered_delivered_again_stored_once(
        self, chaos: Chaos
    ):
        db = chaos.db
        sid = await session_at_field(db, chaos.services, "submitConfirmation")
        first = await chaos.server(failpoints="delivery.afterPost")
        address = await first.listening()
        with contextlib.suppress(Exception):
            await finalize_request(address, sid)
        assert await exits_within(first) == SIGKILLED
        got = [(r.idempotency_key, r.times_received) for r in await chaos.received(sid)]
        assert got == [(f"{sid}:1", 1)]  # the receiver has it
        outbox = await list_outbox(db.pool, sid)
        assert [(o.revision, o.status) for o in outbox] == [(1, "sending")]  # ours doesn't know

        s, _ = await chaos.restart()
        reclaimed = s.log("recovery: outbox leases reclaimed")
        assert reclaimed is not None and reclaimed["count"] >= 1

        async def redelivered() -> bool:
            received = await chaos.received(sid)
            return bool(received) and received[0].times_received == 2

        async def marked() -> bool:
            return (await list_outbox(db.pool, sid))[0].status == "delivered"

        await until(redelivered, "the redelivery")
        await until(marked, "marked delivered")
        got = [(r.idempotency_key, r.times_received) for r in await chaos.received(sid)]
        assert got == [(f"{sid}:1", 2)]  # one row, two sightings
        assert await chaos.revisions(sid) == [1]
        assert (await s.stop()).code == 0


class TestACleanSigtermAsARealProcess:
    async def test_exits_0_in_under_10_s_tells_the_open_chat_socket_1012_and_closes_the_database_last(
        self, chaos: Chaos
    ):
        sid = str(uuid.uuid4())
        s = await chaos.server()
        address = await s.listening()
        chat = connect(ws_url(address, sid), origin=CHAOS_ORIGIN)
        await chat.opened
        await replayed(chat)
        began = time.monotonic()
        exit_ = await s.stop()
        assert time.monotonic() - began < 10
        assert exit_ == Exit(code=0, signal=None)
        closed = await chat.closed
        assert closed.code == 1012 and closed.reason == "server restarting"
        steps = [r["step"] for r in s.logs() if r.get("msg") == "shutdown step done"]
        assert steps == [
            "close sockets",
            "settle calls",
            "stop sweeper",
            "drain commands",
            "stop outbox",
            "close database",
        ]
        assert s.logs()[-1]["msg"] == "shutdown complete"
