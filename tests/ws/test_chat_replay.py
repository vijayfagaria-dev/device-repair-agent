"""WS /chat replay, live fan-out and inbound validation (P3-T04; protocol.md sections 3.3-4), over real sockets and the
throwaway test Postgres. Commands come from test-only handlers that write what P4/P5 handlers will.
(Port of server/test/ws/chatReplay.test.ts.)"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest

from app.db.pool import Database
from app.db.repos.records import insert_record
from app.db.repos.sessions import get_session
from app.db.repos.timers import list_timers
from app.db.repos.turn_metrics import list_turn_metrics, upsert_turn_metric
from app.protocol.schemas import parse_chat_server_message
from tests.helpers.app import connect, start_app, wait_for
from tests.helpers.hooked_pool import HookedPool
from tests.helpers.seed import HASH, seed_session
from tests.helpers.session import seed_call, test_services

Msg = dict[str, Any]

#: The replay's first statement: commits before it are in the replay's snapshot, commits after it aren't.
REPLAY_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db)


@pytest.fixture
async def server(db, services):  # type: ignore[no-untyped-def]
    running = await start_app(db, services=services)
    yield running
    await running.close()


def run(services: Any, id_: str, command: dict[str, Any]) -> Any:
    return services.processor.dispatch(id_, command)


class Chat:
    """An open /chat socket whose replay has ended."""

    def __init__(self, socket: Any) -> None:
        self.socket = socket

    @property
    def all(self) -> list[Msg]:
        return self.socket.messages

    async def close(self) -> None:
        await self.socket.close()


async def open_chat(id_: str, app: Any) -> Chat:
    """Opens /chat and waits until the replay has ended (syncDone)."""
    socket = connect(f"{app.ws}/chat?sessionId={id_}")
    await socket.opened
    await wait_for(lambda: any(m["type"] == "syncDone" for m in socket.messages), "syncDone")
    return Chat(socket)


def sync_index(messages: list[Msg]) -> int:
    return next(i for i, m in enumerate(messages) if m["type"] == "syncDone")


def after_sync(messages: list[Msg]) -> list[Msg]:
    return messages[sync_index(messages) + 1 :]


def before_sync(messages: list[Msg]) -> list[Msg]:
    return messages[: sync_index(messages)]


def thread(messages: list[Msg]) -> list[Msg]:
    """History and cards: what the thread shows (sessionState/syncDone are status, not thread items)."""
    return [m for m in messages if m["type"] not in ("sessionState", "syncDone")]


async def act(db: Database, services: Any, id_: str) -> None:
    """Acts out a session: agent and user chat, call transcript lines, then an open card."""
    call_id = f"c{id_[:8]}"
    await seed_call(db, id_, call_id)
    await run(services, id_, {"type": "Test.StartCall", "callId": call_id})
    await run(
        services,
        id_,
        {
            "type": "Test.Transcript",
            "lineId": f"ta_{call_id}_1",
            "callId": call_id,
            "role": "agent",
            "text": "Hi! What device is it?",
        },
    )
    await run(
        services,
        id_,
        {
            "type": "Test.Transcript",
            "lineId": f"tu_{call_id}_1",
            "callId": call_id,
            "role": "user",
            "text": "An iPhone 14 Pro",
        },
    )
    await run(
        services,
        id_,
        {"type": "Test.Say", "messageId": f"a{id_[:6]}", "text": "I've sent a box for your serial number."},
    )
    await run(services, id_, {"type": "Test.OpenCard", "requestId": "req_email_1", "field": "email"})
    await run(
        services,
        id_,
        {
            "type": "Test.Say",
            "messageId": f"u{id_[:6]}",
            "role": "user",
            "text": "asha@example.com",
            "requestId": "req_email_1",
        },
    )
    await run(services, id_, {"type": "Test.CancelCard", "requestId": "req_email_1"})
    await run(services, id_, {"type": "Test.OpenCard", "requestId": "req_serialNumber_1", "field": "serialNumber"})
    await run(services, id_, {"type": "Test.EndCall"})


class TestReplay:
    async def test_a_new_session_replays_only_its_state_and_sync_done_all_valid_protocol_messages(self, server):
        socket = await open_chat(str(uuid.uuid4()), server)
        assert socket.all == [
            {
                "type": "sessionState",
                "id": "state_0",
                "status": "active",
                "callActive": False,
                "outcome": None,
                "revision": None,
                "voiceAvailable": True,
                "notice": None,
            },
            {"type": "syncDone", "id": "sync_1", "lastSeq": 1},  # session.created
        ]
        await socket.close()

    async def test_act_disconnect_reconnect_the_replayed_thread_equals_the_live_one_ids_and_order(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        live = await open_chat(id_, server)
        await act(db, services, id_)
        await wait_for(
            lambda: any(m.get("id") == "req_serialNumber_1" for m in thread(after_sync(live.all))), "the last card"
        )
        await live.close()

        replayed = await open_chat(id_, server)
        live_thread = thread(after_sync(live.all))
        replay_thread = thread(before_sync(replayed.all))
        # Live, the thread also saw the cancelled card come and go; a reload shows only what's still there (step 3.2).
        settled = [m for m in live_thread if m.get("id") not in ("req_email_1", "cancel_req_email_1")]
        assert replay_thread == settled
        assert [m["id"] for m in replay_thread] == [
            f"ta_c{id_[:8]}_1",
            f"tu_c{id_[:8]}_1",
            f"m_a{id_[:6]}",
            f"m_u{id_[:6]}",
            "req_serialNumber_1",
        ]
        for message in [*replayed.all, *live.all]:
            parse_chat_server_message(message)
        await replayed.close()

    async def test_replays_the_latest_record_and_the_session_state_and_a_server_restart_changes_nothing(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        await act(db, services, id_)
        await insert_record(
            db.pool,
            session_id=id_,
            revision=1,
            outcome="partial",
            payload={"revision": 1, "outcome": "partial"},
            content_hash=HASH,
        )
        await insert_record(
            db.pool,
            session_id=id_,
            revision=2,
            outcome="completed",
            payload={"revision": 2, "outcome": "completed"},
            content_hash="1" * 64,
        )
        first = await open_chat(id_, server)
        assert [m for m in first.all if m["type"] == "record"] == [
            {"type": "record", "id": "rec_2", "record": {"revision": 2, "outcome": "completed"}}
        ]
        await first.close()

        restarted = await start_app(db, services=test_services(db))  # a new process: empty hub, nothing in memory
        try:
            second = await open_chat(id_, restarted)
            assert second.all == first.all
            await second.close()
        finally:
            await restarted.close()

    async def test_an_event_committed_while_the_replay_is_being_read_arrives_exactly_once(self, db, services):
        id_ = await seed_session(db.pool)
        # The socket's pool pauses around its replay's snapshot: one message commits just before the snapshot starts (so
        # it's in the replay AND in the hub buffer, filtered by seq), one just after last_seq is read (only in the
        # buffer). A card opened then is not in the replay either (one snapshot), so it arrives live, after the message
        # before it.
        armed = True

        async def hook(text: str, values: Any, phase: str) -> None:
            nonlocal armed
            if not armed:
                return
            if phase == "before" and text.startswith(REPLAY_BEGIN):
                await run(
                    services, id_, {"type": "Test.Say", "messageId": f"before{id_[:4]}", "text": "committed before"}
                )
            elif phase == "after" and values and values[0] == id_ and "max(seq)" in text:
                armed = False
                await run(
                    services, id_, {"type": "Test.Say", "messageId": f"after{id_[:4]}", "text": "committed after"}
                )
                await run(services, id_, {"type": "Test.OpenCard", "requestId": "req_email_1", "field": "email"})

        app = await start_app(Database(pool=HookedPool(db.pool, hook), stats=db.stats), services=services)  # type: ignore[arg-type]
        try:
            socket = await open_chat(id_, app)
            await wait_for(lambda: any(m.get("id") == f"m_after{id_[:4]}" for m in socket.all), "the later message")
            ids = [m.get("id") for m in socket.all]
            assert ids.count(f"m_before{id_[:4]}") == 1
            assert ids.count(f"m_after{id_[:4]}") == 1
            await wait_for(lambda: any(m.get("id") == "req_email_1" for m in socket.all), "the card")
            await asyncio.sleep(0.1)  # room for a duplicate to arrive
            assert len([m for m in socket.all if m.get("id") == "req_email_1"]) == 1
            assert f"m_before{id_[:4]}" in [m.get("id") for m in before_sync(socket.all)]  # replayed
            assert f"m_after{id_[:4]}" in [m.get("id") for m in after_sync(socket.all)]  # live, after syncDone
            # The thread order is the commit order: the card is not replayed ahead of the message committed before it.
            assert "req_email_1" not in [m.get("id") for m in before_sync(socket.all)]
            live = [m.get("id") for m in after_sync(socket.all)]
            assert live.index(f"m_after{id_[:4]}") < live.index("req_email_1")
            await socket.close()
        finally:
            await app.close()

    async def test_a_replay_that_fails_closes_1011_the_client_retries_and_leaves_no_listener_behind(
        self, db, services
    ):
        id_ = await seed_session(db.pool)

        async def hook(text: str, _values: Any, phase: str) -> None:
            if phase == "before" and text.startswith(REPLAY_BEGIN):
                raise ConnectionError("connection lost")

        app = await start_app(Database(pool=HookedPool(db.pool, hook), stats=db.stats), services=services)  # type: ignore[arg-type]
        try:
            socket = connect(f"{app.ws}/chat?sessionId={id_}")
            closed = await socket.closed
            assert (closed.code, closed.reason) == (1011, "server error")
            assert socket.messages == [{"type": "closing", "code": 1011, "reason": "server error"}]
            await wait_for(lambda: services.hub.listener_count(id_) == 0, "listener cleanup")
        finally:
            await app.close()

    async def test_doesnt_resend_a_buffered_event_that_the_replay_already_reflects(self, db, services):
        id_ = await seed_session(db.pool)
        await run(services, id_, {"type": "Test.OpenCard", "requestId": "req_serialNumber_1", "field": "serialNumber"})
        # A rejection commits after the socket subscribed but before the replay reads last_seq: the replay's open card
        # is already "after" it, and the buffered inputError is older than the replay, so it must not reach the client.
        armed = True

        async def hook(text: str, _values: Any, phase: str) -> None:
            nonlocal armed
            if not armed or phase != "before" or not text.startswith(REPLAY_BEGIN):
                return
            armed = False
            await run(services, id_, {"type": "Test.Reject", "requestId": "req_serialNumber_1"})

        app = await start_app(Database(pool=HookedPool(db.pool, hook), stats=db.stats), services=services)  # type: ignore[arg-type]
        try:
            socket = await open_chat(id_, app)
            # Proves the stream is live:
            await run(services, id_, {"type": "Test.Say", "messageId": f"s{id_[:6]}", "text": "a later message"})
            await wait_for(lambda: any(m.get("id") == f"m_s{id_[:6]}" for m in socket.all), "the later message")
            assert [m for m in socket.all if m["type"] == "inputError"] == []
            assert len([m for m in socket.all if m.get("id") == "req_serialNumber_1"]) == 1
            await socket.close()
        finally:
            await app.close()

    async def test_a_connect_is_not_user_activity_it_writes_nothing_and_moves_no_timer(self, db, services, server):
        id_ = await seed_session(db.pool)
        await run(services, id_, {"type": "Test.Activity"})
        before = await get_session(db.pool, id_)
        timers = await list_timers(db.pool, id_)
        socket = await open_chat(id_, server)
        await socket.close()
        again = await open_chat(id_, server)
        await again.close()
        assert await get_session(db.pool, id_) == before
        assert await list_timers(db.pool, id_) == timers


class TestLiveFanOut:
    async def test_two_tabs_receive_identical_ordered_streams_listeners_are_removed_when_the_sockets_close(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        a = await open_chat(id_, server)
        b = await open_chat(id_, server)
        assert services.hub.listener_count(id_) == 2
        for i in range(1, 11):
            await run(services, id_, {"type": "Test.Say", "messageId": f"t{i}x{id_[:6]}", "text": f"message {i}"})
        await wait_for(lambda: len(after_sync(a.all)) >= 10 and len(after_sync(b.all)) >= 10, "10 messages on both")
        assert after_sync(a.all) == after_sync(b.all)
        assert [m["text"] for m in after_sync(a.all)] == [f"message {i + 1}" for i in range(10)]
        await a.close()
        await b.close()
        await asyncio.gather(a.socket.closed, b.socket.closed)
        await wait_for(lambda: services.hub.listener_count(id_) == 0, "listener cleanup")

    async def test_sends_session_state_when_what_the_client_sees_changes_not_on_every_command(
        self, db, services, server
    ):
        id_ = await seed_session(db.pool)
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id)
        socket = await open_chat(id_, server)
        await run(services, id_, {"type": "Test.Append", "n": 1})
        await run(services, id_, {"type": "Test.StartCall", "callId": call_id})
        await run(services, id_, {"type": "Test.Append", "n": 2})
        await run(services, id_, {"type": "Test.EndCall"})
        await wait_for(lambda: len(after_sync(socket.all)) >= 2, "two state changes")
        await asyncio.sleep(0.1)
        assert [(m["type"], m["callActive"]) for m in after_sync(socket.all)] == [
            ("sessionState", True),
            ("sessionState", False),
        ]
        await socket.close()


class TestInboundMessages:
    async def test_answers_an_input_response_to_a_request_that_isnt_open_with_input_error_and_stays_open(
        self, db, server
    ):
        id_ = await seed_session(db.pool)
        socket = await open_chat(id_, server)
        await socket.socket.send(
            json.dumps({"type": "inputResponse", "requestId": "req_email_1", "field": "email", "value": "a@b.co"})
        )
        await wait_for(lambda: any(m["type"] == "inputError" for m in socket.all), "inputError")
        assert socket.all[-1] == {
            "type": "inputError",
            "id": "err_req_email_1_0",
            "requestId": "req_email_1",
            "message": "This request is no longer active.",
        }
        await socket.close()

    # optOut was accepted silently here until P4-T05 gave it a handler: it now opens "Stop your claim?" (covered in the
    # chat-only scenarios), so it left this list of messages that get no answer.
    async def test_drops_invalid_oversized_value_and_unknown_messages_without_answering_client_metric_is_silent(
        self, db, server
    ):
        id_ = await seed_session(db.pool)
        socket = await open_chat(id_, server)
        count = len(socket.all)
        for bad in [
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": "x" * 1001},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": {"nested": True}},
            {"type": "inputResponse", "requestId": "", "field": "f", "value": "x"},
            {"type": "clientMetric", "name": "turnLatency", "turnId": "ta_c_1", "ms": 60_001, "at": "now"},
            {"type": "unknownType"},
            [1, 2, 3],
        ]:
            await socket.socket.send(json.dumps(bad))
        await socket.socket.send(
            json.dumps(
                {
                    "type": "clientMetric",
                    "name": "turnLatency",
                    "turnId": "ta_c_1",
                    "ms": 1384,
                    "at": "2026-11-07T10:02:14.512+05:30",
                }
            )
        )
        await socket.socket.send(bytes([1, 2, 3]))
        await asyncio.sleep(0.2)
        assert len(socket.all) == count
        assert socket.socket.is_open
        await socket.close()


def metric_message(turn_id: str, ms: float) -> str:
    return json.dumps(
        {"type": "clientMetric", "name": "turnLatency", "turnId": turn_id, "ms": ms, "at": "2026-11-07T10:02:14.512+05:30"}
    )


async def rows_of(db: Database, session_id: str) -> list[Any]:
    return [[r.turn_id, r.client_ms] for r in await list_turn_metrics(db.pool, session_id)]


class TestClientMetricIsStored:
    """P11-T02."""

    async def test_keeps_the_perceived_latency_of_a_turn_of_this_sessions_call_and_nothing_for_anyone_elses(
        self, db, server
    ):
        mine = await seed_session(db.pool)
        other = await seed_session(db.pool)
        await seed_call(db, mine, "c_mine")
        await seed_call(db, other, "c_other")
        socket = await open_chat(mine, server)

        await socket.socket.send(metric_message("ta_c_mine_2", 1384.4))
        for _ in range(100):
            if await rows_of(db, mine):
                break
            await asyncio.sleep(0.02)
        assert await rows_of(db, mine) == [["ta_c_mine_2", 1384]]

        await asyncio.sleep(1.1)  # one clientMetric per second per socket (protocol.md section 7)
        await socket.socket.send(metric_message("ta_c_other_1", 900))  # a call of another session
        await asyncio.sleep(1.1)
        await socket.socket.send(metric_message("tu_c_mine_1", 900))  # a user line, not an agent turn
        await asyncio.sleep(1.1)
        await socket.socket.send(metric_message("ta_c_nowhere_1", 900))  # no such call
        await asyncio.sleep(0.3)

        assert await rows_of(db, other) == []
        assert await rows_of(db, mine) == [["ta_c_mine_2", 1384]]
        assert socket.socket.is_open
        await socket.close()

    async def test_merges_with_the_servers_row_whichever_arrives_first_and_an_excess_sample_within_a_second_is_dropped(
        self, db, server
    ):
        id_ = await seed_session(db.pool)
        await seed_call(db, id_, "c_merge")
        socket = await open_chat(id_, server)
        await socket.socket.send(metric_message("ta_c_merge_1", 700))
        await socket.socket.send(metric_message("ta_c_merge_2", 800))  # within the same second: dropped
        for _ in range(100):
            if await rows_of(db, id_):
                break
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.2)
        assert await rows_of(db, id_) == [["ta_c_merge_1", 700]]
        # The server's numbers for that turn arrive later and join the same row.
        await upsert_turn_metric(
            db.pool,
            turn_id="ta_c_merge_1",
            session_id=id_,
            call_id="c_merge",
            user_end_at=datetime.now(UTC),
            server_ms=640,
        )
        [row] = await list_turn_metrics(db.pool, id_)
        assert (row.turn_id, row.client_ms, row.server_ms) == ("ta_c_merge_1", 700, 640)
        await socket.close()
