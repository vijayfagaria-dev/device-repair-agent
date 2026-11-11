"""WS /chat handshake (P1-T03; protocol.md sections 2, 4 step 1, 6 and 7): Origin, session id, lazy creation, rate limit,
keepalive and shutdown, over a real socket. (Port of server/test/ws/chat.test.ts.)"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.db.pool import create_database
from app.db.repos.events import list_events
from app.db.repos.sessions import get_session
from app.protocol.schemas import parse_chat_server_message
from app.ws.keep_alive import KeepAliveOptions
from app.ws.plugin import SHUTDOWN_CLOSE_GRACE_MS
from tests.helpers.app import ORIGIN, Closed, closed_within, connect, raw_connect, start_app


@pytest.fixture
async def server(db):  # type: ignore[no-untyped-def]
    running = await start_app(db)
    yield running
    await running.close()


def chat_url(base: str, query: str) -> str:
    return f"{base}/chat{query}"


async def session_count(db) -> int:  # type: ignore[no-untyped-def]
    return int(await db.pool.fetchval("SELECT count(*)::int FROM sessions"))


async def wait_for_session(db, id_: str):  # type: ignore[no-untyped-def]
    """Polls until the session row exists (the handshake commits after the upgrade completes)."""
    for _ in range(50):
        session = await get_session(db.pool, id_)
        if session:
            return session
        await asyncio.sleep(0.02)
    raise AssertionError(f"session {id_} was not created")


class TestValidConnect:
    async def test_creates_the_session_lazily_on_first_connect_and_keeps_the_socket_open(self, db, server):
        id_ = str(uuid.uuid4())
        assert await get_session(db.pool, id_) is None
        socket = connect(chat_url(server.ws, f"?sessionId={id_}"))
        await socket.opened
        session = await wait_for_session(db, id_)
        assert session.status == "active"
        events = await list_events(db.pool, id_)
        assert [(e.seq, e.type, e.payload) for e in events] == [(1, "session.created", {"via": "chat"})]
        assert await closed_within(socket, 300) == "open"
        await socket.close()

    async def test_a_reconnect_or_a_second_tab_loads_the_same_session_without_creating_anything(self, db, server):
        id_ = str(uuid.uuid4())
        first = connect(chat_url(server.ws, f"?sessionId={id_}"))
        await first.opened
        await wait_for_session(db, id_)
        second = connect(chat_url(server.ws, f"?sessionId={id_}"))
        await second.opened
        assert await closed_within(second, 200) == "open"
        assert len(await list_events(db.pool, id_)) == 1
        await first.close()
        await second.close()

    async def test_treats_an_uppercase_id_as_the_same_canonical_lowercase_session(self, db, server):
        id_ = str(uuid.uuid4())
        socket = connect(chat_url(server.ws, f"?sessionId={id_.upper()}"))
        await socket.opened
        await wait_for_session(db, id_)
        assert await closed_within(socket, 200) == "open"
        await socket.close()

    async def test_drops_malformed_client_messages_and_stays_open_only_the_replay_is_sent(self, server):
        socket = connect(chat_url(server.ws, f"?sessionId={uuid.uuid4()}"))
        await socket.opened
        await socket.send('{"type": "inputResponse", "requestId": "x"}')  # no field or value
        await socket.send("not json")
        await socket.send('{"type": "somethingNew"}')
        assert await closed_within(socket, 300) == "open"
        # A new session's replay: its state and the end of the replay, nothing in reply to the bad messages.
        assert [m["type"] for m in socket.messages] == ["sessionState", "syncDone"]
        await socket.close()


class TestRefusals:
    """The upgrade completes, then the server closes with a code and reason."""

    async def test_closes_4400_for_a_malformed_missing_or_repeated_session_id_creating_nothing(self, db, server):
        before = await session_count(db)
        valid = str(uuid.uuid4())
        for query in [
            "?sessionId=abc",
            "",
            "?sessionId=",
            f"?sessionId={valid}x",
            f"?sessionId={valid}&sessionId={uuid.uuid4()}",
            f"?sessionid={valid}",
        ]:
            socket = connect(chat_url(server.ws, query))
            await socket.opened  # the browser sees onopen, then the reason (protocol.md section 6)
            assert await socket.closed == Closed(4400, "invalid session id"), query
        assert await session_count(db) == before

    async def test_sends_a_closing_message_with_the_same_code_and_reason_first(self, server):
        for query, origin, code, reason in [
            ("?sessionId=abc", ORIGIN, 4400, "invalid session id"),
            (f"?sessionId={uuid.uuid4()}", "https://evil.example.com", 4403, "origin not allowed"),
        ]:
            socket = connect(chat_url(server.ws, query), origin=origin)
            assert await socket.closed == Closed(code, reason)
            assert socket.messages == [{"type": "closing", "code": code, "reason": reason}]
            parse_chat_server_message(socket.messages[0])  # a valid protocol message

    async def test_closes_4403_for_a_foreign_or_missing_origin_before_touching_the_session(self, db, server):
        before = await session_count(db)
        for origin in [
            "https://evil.example.com",
            "http://repair.example.com",
            f"{ORIGIN}:443",
            f"{ORIGIN}/",
            "null",
            None,
        ]:
            id_ = str(uuid.uuid4())
            socket = connect(chat_url(server.ws, f"?sessionId={id_}"), origin=origin)
            assert await socket.closed == Closed(4403, "origin not allowed"), str(origin)
            assert await get_session(db.pool, id_) is None
        assert await session_count(db) == before

    async def test_closes_1011_when_the_database_is_unreachable_the_client_retries(self):
        down = await create_database("postgresql://nobody@127.0.0.1:1/none", on_error=lambda _e: None)
        broken = await start_app(down)
        try:
            socket = connect(chat_url(broken.ws, f"?sessionId={uuid.uuid4()}"))
            assert await socket.closed == Closed(1011, "server error")
        finally:
            await broken.close()
            await down.close()

    async def test_closes_1009_for_a_message_over_64_kb(self, server):
        socket = connect(chat_url(server.ws, f"?sessionId={uuid.uuid4()}"))
        await socket.opened
        await socket.send("x" * (64 * 1024 + 1))
        assert (await socket.closed).code == 1009

    async def test_answers_a_plain_http_get_chat_no_upgrade_with_the_json_404(self, server):
        async with server.client() as client:
            res = await client.get(f"/chat?sessionId={uuid.uuid4()}")
        assert res.status_code == 404
        assert res.json() == {"error": "not_found"}


class TestNewSessionRateLimit:
    async def test_closes_4429_beyond_the_limit_existing_sessions_still_connect(self, db):
        limited = await start_app(db, new_sessions_per_ip_per_hour=2)
        try:
            ids = [str(uuid.uuid4()), str(uuid.uuid4())]
            for id_ in ids:
                socket = connect(chat_url(limited.ws, f"?sessionId={id_}"))
                await socket.opened
                await wait_for_session(db, id_)
                await socket.close()
            refused_id = str(uuid.uuid4())
            refused = connect(chat_url(limited.ws, f"?sessionId={refused_id}"))
            assert await refused.closed == Closed(4429, "rate limited")
            assert await get_session(db.pool, refused_id) is None

            again = connect(chat_url(limited.ws, f"?sessionId={ids[0]}"))
            await again.opened
            assert await closed_within(again, 200) == "open"
            await again.close()
        finally:
            await limited.close()

    async def test_keys_on_the_forwarded_client_ip_only_when_proxy_hops_are_trusted(self, db):
        # Trusting one hop: each X-Forwarded-For client gets its own budget.
        behind_proxy = await start_app(db, new_sessions_per_ip_per_hour=1, trust_proxy_hops=1)
        # Trusting none: the header is ignored, so both share the socket address's budget.
        direct = await start_app(db, new_sessions_per_ip_per_hour=1)
        try:

            async def open_(base: str, forwarded_for: str):
                socket = connect(
                    chat_url(base, f"?sessionId={uuid.uuid4()}"), headers={"x-forwarded-for": forwarded_for}
                )
                result = await closed_within(socket, 300)
                await socket.close()
                return "open" if result == "open" else result.code  # type: ignore[union-attr]

            assert await open_(behind_proxy.ws, "203.0.113.1") == "open"
            assert await open_(behind_proxy.ws, "203.0.113.2") == "open"
            assert await open_(behind_proxy.ws, "203.0.113.1") == 4429
            # A client can't escape by prepending its own entry: only the hop nearest the trusted proxy counts.
            assert await open_(behind_proxy.ws, "198.51.100.9, 203.0.113.1") == 4429

            assert await open_(direct.ws, "203.0.113.1") == "open"
            assert await open_(direct.ws, "203.0.113.2") == 4429
        finally:
            await behind_proxy.close()
            await direct.close()


class TestKeepaliveAndShutdown:
    async def test_terminates_a_client_that_stops_answering_pings_and_keeps_one_that_answers(self, db):
        # The pings are the ASGI server's (uvicorn ws_ping_interval / ws_ping_timeout, see ws.keep_alive).
        fast = await start_app(db, keep_alive=KeepAliveOptions(interval_ms=50, max_missed=2))
        try:
            silent = raw_connect(chat_url(fast.ws, f"?sessionId={uuid.uuid4()}"))
            healthy = connect(chat_url(fast.ws, f"?sessionId={uuid.uuid4()}"))
            await asyncio.gather(silent.opened, healthy.opened)
            silent_close = await closed_within(silent, 1_000)
            assert silent_close != "open"
            # uvicorn closes with 1011 "keepalive ping timeout" (a close frame) before dropping the connection.
            assert silent_close.code in (1006, 1011)  # type: ignore[union-attr]
            assert await closed_within(healthy, 200) == "open"
            await healthy.close()
        finally:
            await fast.close()

    async def test_closes_open_sockets_with_1012_server_restarting_when_the_server_shuts_down(self, db):
        closing = await start_app(db)
        socket = connect(chat_url(closing.ws, f"?sessionId={uuid.uuid4()}"))
        await socket.opened
        await closed_within(socket, 100)  # let the handshake finish
        closed, _ = await asyncio.gather(socket.closed, closing.close())
        assert closed == Closed(1012, "server restarting")
        # The closing message says the same, first (for proxies that rewrite close codes).
        assert socket.messages[-1] == {"type": "closing", "code": 1012, "reason": "server restarting"}

    async def test_drops_a_client_that_never_answers_the_close_so_shutdown_ends_after_the_grace_period(self, db):
        closing = await start_app(db)
        id_ = str(uuid.uuid4())
        # A raw TCP client that completes the upgrade and then never reads or answers anything.
        raw = raw_connect(chat_url(closing.ws, f"?sessionId={id_}"))
        try:
            await wait_for_session(db, id_)
            started = asyncio.get_running_loop().time()
            await closing.close()
            elapsed_ms = (asyncio.get_running_loop().time() - started) * 1000
            # uvicorn reports the server's own close at once (no wait for the peer's reply), so this ends well within
            # the grace period (the TS `ws` waited out the whole grace); the bound is what matters: never ws's 30 s.
            assert elapsed_ms < SHUTDOWN_CLOSE_GRACE_MS + 1_500
        finally:
            raw.destroy()
