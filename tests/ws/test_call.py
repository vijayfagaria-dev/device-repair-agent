"""WS /call (P5-T02, P5-T09, P5-T12) over real sockets and the throwaway test Postgres, with fake providers: every way a
call ends gives exactly one call.ended with the right reason; the refusals; frame validation; the hand-off to chat after a
hang-up within 1 s; a returning call; spoken fields stored through the real commands. (Port of server/test/ws/call.test.ts.)"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

import pytest

from app.db.repos.calls import list_calls
from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.input_requests import list_input_requests
from app.db.repos.sessions import get_session
from app.db.repos.transcript_lines import list_transcript_lines
from app.voice.call_engine import CallTimings
from app.voice.fakes.llm import FakeLlm, LlmScript
from app.voice.fakes.stt import FakeStt
from app.voice.fakes.tts import FakeTts
from app.ws.call import Providers, VoiceDeps, settle_calls
from app.ws.keep_alive import KeepAliveOptions
from tests.helpers.app import Closed, RawSocket, connect, raw_connect, start_app, wait_for
from tests.helpers.seed import seed_session
from tests.helpers.session import test_services


class Voice:
    """The fake providers of the current test; `fresh()` replaces them (the TS test's module variables)."""

    def __init__(self) -> None:
        self.fresh()

    def fresh(self) -> None:
        self.stt = FakeStt()
        self.tts = FakeTts()
        self.llm = FakeLlm()
        self.llm.fallback = LlmScript(text="Okay.")

    def deps(self, **overrides: Any) -> VoiceDeps:
        settings: dict[str, Any] = {
            "providers": lambda: Providers(self.stt, self.tts, self.llm),
            "max_concurrent_calls": 5,
            "timings": CallTimings(silence_ms=60_000),
        }
        settings.update(overrides)
        return VoiceDeps(**settings)


@pytest.fixture
async def rig(db):  # type: ignore[no-untyped-def]
    voice = Voice()
    services = test_services(db, planner=True)
    server = await start_app(db, services=services, voice=voice.deps())
    voice.db = db
    voice.services = services
    voice.server = server
    yield voice
    await server.close()


async def ended(db: Any, id_: str) -> list[Any]:
    return [e.payload["reason"] for e in await list_events(db.pool, id_) if e.type == "call.ended"]


def kind(message: Any) -> str:
    return message["type"]


async def open_call(id_: str, app: Any, *, raw: bool = False) -> Any:
    url = f"{app.ws}/call?sessionId={id_}"
    socket = raw_connect(url) if raw else connect(url)
    await socket.opened
    return socket


async def active_call_id(db: Any, id_: str) -> str | None:
    session = await get_session(db.pool, id_)
    return session.active_call_id if session else None


async def call_started(db: Any, id_: str) -> bool:
    return await active_call_id(db, id_) is not None


class TestStartingACall:
    async def test_creates_the_session_lazily_starts_the_call_once_and_greets(self, rig):
        db = rig.db
        rig.llm.enqueue(LlmScript(text="Hi, I'm Riya. What device is it?"))
        id_ = str(uuid.uuid4())
        socket = await open_call(id_, rig.server)
        await wait_for(
            lambda: any(kind(m) == "transcript" and m["final"] for m in socket.messages), "the greeting"
        )
        assert any(kind(m) == "audio" for m in socket.messages)
        session = await get_session(db.pool, id_)
        assert session is not None and session.active_call_id is not None
        import re

        assert re.fullmatch(r"c[A-Za-z0-9-]+", session.active_call_id)
        assert [c.ended_at for c in await list_calls(db.pool, id_)] == [None]
        assert [e.type for e in await list_events(db.pool, id_)][:2] == ["session.created", "call.started"]
        await socket.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")

    async def test_a_second_call_on_the_same_session_gets_4409_the_first_goes_on(self, rig):
        db = rig.db
        id_ = await seed_session(db.pool)
        first = await open_call(id_, rig.server)
        await wait_for(lambda: call_started(db, id_), "the first call")
        second = await open_call(id_, rig.server)
        assert await second.closed == Closed(4409, "call already active")
        assert first.is_open
        await first.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")

    # Live report (2026-11-11): pressing Call while the same claim's call was still running said "Voice is busy right
    # now", because the capacity check (cap 1) ran before the per-session check.
    async def test_with_a_cap_of_1_a_second_call_from_the_same_session_is_told_a_call_is_already_active_not_busy(
        self, rig
    ):
        db = rig.db
        capped = await start_app(db, services=rig.services, voice=rig.deps(max_concurrent_calls=1))
        try:
            id_ = await seed_session(db.pool)
            first = await open_call(id_, capped)
            await wait_for(lambda: call_started(db, id_), "the first call")
            second = await open_call(id_, capped)
            assert await second.closed == Closed(4409, "call already active")
            assert first.is_open
            # Another session is still refused for capacity: the cap itself is unchanged.
            other = await open_call(await seed_session(db.pool), capped)
            assert await other.closed == Closed(4429, "capacity")
            await first.close(1000)
            await first.closed
            await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")
            # The session's slot and the instance's slot are both free again.
            await wait_for(lambda: call_slots_free(capped), "the slots to be free")
            rig.fresh()
            again = await open_call(id_, capped)
            await wait_for(lambda: call_started(db, id_), "the call to start again")
            assert again.is_open
            await again.close(1000)
            await again.closed
        finally:
            await capped.close()

    async def test_p7_t05_calling_on_an_opted_out_session_is_refused_with_4411_calling_on_a_completed_one_reopens_it(
        self, rig
    ):
        db = rig.db
        opted_out = await seed_session(db.pool)
        await db.pool.execute(
            "UPDATE sessions SET status = 'finalized', outcome = 'optedOut', current_revision = 1 WHERE id = $1",
            opted_out,
        )
        assert await (await open_call(opted_out, rig.server)).closed == Closed(4411, "resume required")
        assert [(r.field, r.status) for r in await list_input_requests(db.pool, opted_out)] == [
            ("resumeConfirmation", "open")
        ]
        assert (await get_session(db.pool, opted_out)).status == "finalized"
        assert await ended(db, opted_out) == []  # no call was ever started

        completed = await seed_session(db.pool)
        await db.pool.execute(
            "UPDATE sessions SET status = 'finalized', outcome = 'completed', current_revision = 1 WHERE id = $1",
            completed,
        )
        call = await open_call(completed, rig.server)
        await wait_for(lambda: call_started(db, completed), "the call to start")
        assert (await get_session(db.pool, completed)).status == "active"
        types = [e.type for e in await list_events(db.pool, completed)]
        assert "session.reopened" in types and "call.started" in types
        await call.close(1000)
        await call.closed
        await wait_for(lambda: _len_is(ended(db, completed), 1), "the call to end")

    async def test_refuses_beyond_the_per_instance_cap_a_closed_session_and_without_voice_configured(self, rig):
        db = rig.db
        capped = await start_app(db, services=rig.services, voice=rig.deps(max_concurrent_calls=1))
        try:
            a = await open_call(await seed_session(db.pool), capped)
            await wait_for(lambda: len(a.messages) > 0, "the first call")
            b = await open_call(await seed_session(db.pool), capped)
            assert await b.closed == Closed(4429, "capacity")
            await a.close(1000)
            await a.closed
        finally:
            await capped.close()
        closed_id = await seed_session(db.pool)
        await db.pool.execute("UPDATE sessions SET status = 'closed' WHERE id = $1", closed_id)
        assert await (await open_call(closed_id, rig.server)).closed == Closed(4410, "session closed")
        no_voice = await start_app(db, services=rig.services)
        try:
            socket = await open_call(await seed_session(db.pool), no_voice)
            assert await socket.closed == Closed(1011, "server error")
        finally:
            await no_voice.close()

    async def test_applies_the_same_refusals_as_chat_origin_session_id_and_a_plain_get_call_is_the_json_404(
        self, rig
    ):
        foreign = connect(f"{rig.server.ws}/call?sessionId={uuid.uuid4()}", origin="https://evil.example.com")
        assert (await foreign.closed).code == 4403
        bad = connect(f"{rig.server.ws}/call?sessionId=nope")
        assert (await bad.closed).code == 4400
        async with rig.server.client() as client:
            res = await client.get("/call")
        assert res.status_code == 404


class TestMicFrames:
    async def test_640_byte_binary_frames_go_to_stt_text_and_other_sizes_are_dropped_over_4_kb_closes_1009(self, rig):
        db = rig.db
        id_ = await seed_session(db.pool)
        socket = await open_call(id_, rig.server)
        await wait_for(lambda: len(rig.stt.streams) == 1, "the STT stream")
        for _ in range(10):
            await socket.send(bytes(640))
        await socket.send(bytes(639))
        await socket.send("not audio")
        await wait_for(lambda: rig.stt.current.bytes == 6400, "10 frames forwarded")
        await socket.send(bytes(5000))
        assert (await socket.closed).code == 1009
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")


class TestEveryWayACallEnds:
    """Exactly one call.ended, with its reason."""

    async def end_with(self, rig, action, app=None, *, raw: bool = False) -> tuple[str, list[Any]]:
        rig.fresh()
        db = rig.db
        app = app or rig.server
        id_ = await seed_session(db.pool)
        socket = await open_call(id_, app, raw=raw)
        await wait_for(lambda: call_started(db, id_), "call started")
        await wait_for(lambda: len(rig.stt.streams) == 1, "the providers open")
        await action(socket, id_)
        await wait_for(lambda: _at_least(ended(db, id_), 1), "call.ended")
        await asyncio.sleep(0.1)  # nothing more arrives
        session = await get_session(db.pool, id_)
        assert session.active_call_id is None
        assert all(c.ended_at is not None for c in await list_calls(db.pool, id_))
        return id_, await ended(db, id_)

    async def test_hang_up_close_1000_is_hangup_the_tab_closing_1001_is_hangup(self, rig):
        async def hang_up(code):
            async def action(socket, _id):
                await socket.close(code)

            return action

        assert (await self.end_with(rig, await hang_up(1000)))[1] == ["hangup"]
        assert (await self.end_with(rig, await hang_up(1001)))[1] == ["hangup"]

    async def test_network_loss_pongs_blocked_the_keepalive_terminates_the_socket_is_network(self, rig):
        short = await start_app(
            rig.db,
            services=rig.services,
            voice=rig.deps(),
            keep_alive=KeepAliveOptions(interval_ms=50, max_missed=2),
        )
        try:

            async def nothing(_socket, _id):
                return None

            assert (await self.end_with(rig, nothing, short, raw=True))[1] == ["network"]
        finally:
            await short.close()

    async def test_server_shutdown_1012_is_server_restart(self, rig):
        doomed = await start_app(rig.db, services=rig.services, voice=rig.deps())

        async def shut_down(_socket, _id):
            await doomed.close()

        result = await self.end_with(rig, shut_down, doomed)
        assert result[1] == ["server_restart"]

    async def test_the_maximum_duration_is_max_duration_and_the_socket_is_closed_1000_max_duration(self, rig):
        short = await start_app(
            rig.db,
            services=rig.services,
            voice=rig.deps(timings=CallTimings(silence_ms=60_000, max_call_ms=300)),
        )
        try:
            closes: list[Closed] = []

            async def wait_close(socket, _id):
                closes.append(await socket.closed)

            result = await self.end_with(rig, wait_close, short)
            assert result[1] == ["max_duration"]
            assert closes[0] == Closed(1000, "max duration")
        finally:
            await short.close()

    async def test_the_agent_ending_it_end_call_after_its_goodbye_is_agent_ended_closed_agent_ended(self, rig):
        closes: list[Closed] = []

        async def agent_ends(socket, _id):
            rig.llm.enqueue(LlmScript(text="Thanks, goodbye!", tool_calls=[{"name": "end_call", "args": {}}]))
            rig.stt.current.say("that's all thanks")
            closes.append(await socket.closed)

        result = await self.end_with(rig, agent_ends)
        assert result[1] == ["agent_ended"]
        assert closes[0] == Closed(1000, "agent ended")


class TestHandOffToChat:
    async def test_a_hang_up_mid_way_the_next_missing_fields_card_reaches_the_chat_within_1_s(self, rig):
        db = rig.db
        rig.llm.enqueue(
            LlmScript(text="Hi! What device is it?"),
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {"field": "deviceType", "value": "smartphone", "spoken_evidence": "a phone"},
                    }
                ]
            ),
            LlmScript(text="Which model?"),
        )
        id_ = await seed_session(db.pool)
        chat = connect(f"{rig.server.ws}/chat?sessionId={id_}")
        await chat.opened
        call = await open_call(id_, rig.server)
        await wait_for(lambda: len(rig.stt.streams) == 1, "STT")
        rig.stt.current.say("It's a phone")
        await wait_for(lambda: _len_is(list_field_candidates(db.pool, id_, "deviceType"), 1), "deviceType saved")
        hung_up_at = time.monotonic()
        await call.close(1000)
        await wait_for(lambda: any(kind(m) == "inputRequest" for m in chat.messages), "the chat card", 1.0)
        assert time.monotonic() - hung_up_at <= 1.0
        card = next(m for m in chat.messages if kind(m) == "inputRequest")
        assert card["field"] == "serialNumber"  # after a call: the chat fields first; deviceType isn't asked again
        candidate = (await list_field_candidates(db.pool, id_, "deviceType"))[0]
        assert (candidate.source, candidate.status, candidate.normalized) == ("call", "valid", "smartphone")
        await chat.close()

    async def test_the_calls_final_lines_are_stored_both_sides_in_order_interim_lines_arent(self, rig):
        db = rig.db
        rig.llm.enqueue(LlmScript(text="Hello, what device is it?"), LlmScript(text="A laptop, got it."))
        id_ = await seed_session(db.pool)
        call = await open_call(id_, rig.server)
        await wait_for(lambda: len(rig.stt.streams) == 1, "STT")
        await wait_for(lambda: _len_is(list_transcript_lines(db.pool, id_), 1), "the greeting line")
        rig.stt.current.say("It is a laptop")
        await wait_for(lambda: _len_is(list_transcript_lines(db.pool, id_), 3), "three lines")
        assert [(line.role, line.text) for line in await list_transcript_lines(db.pool, id_)] == [
            ("agent", "Hello, what device is it?"),
            ("user", "It is a laptop"),
            ("agent", "A laptop, got it."),
        ]
        await call.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")


class TestAReturningCall:
    async def test_the_second_call_is_marked_returning_and_its_first_turn_knows_whats_collected(self, rig):
        db = rig.db
        rig.llm.enqueue(LlmScript(text="Hi! And when did the problem start?"))
        id_ = await seed_session(db.pool)
        await rig.services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "deviceType",
                "source": "call",
                "raw": "x",
                "normalized": "laptop",
                "status": "valid",
            },
        )
        first = await open_call(id_, rig.server)
        await wait_for(lambda: _len_is(list_transcript_lines(db.pool, id_), 1), "first call's greeting")
        await first.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 1), "first call ended")
        await wait_for(lambda: call_slots_free(rig.server), "the first call to be gone")

        rig.fresh()
        rig.llm.enqueue(LlmScript(text="Welcome back!"))
        second = await open_call(id_, rig.server)
        await wait_for(lambda: len(rig.llm.requests) >= 1, "the second call's first turn")
        messages = rig.llm.requests[0].messages
        first_user = next(m for m in messages if m.role == "user")
        assert (first_user.role, first_user.content) == ("user", "(The customer called back.)")
        state = json.loads(str(messages[-1].content)[len("STATE ") :])
        assert state["isReturningCall"] is True
        assert state["lastQuestionOnPreviousCall"] == "Hi! And when did the problem start?"
        assert state["collected"]["deviceType"] == '<customer_words field="deviceType">Laptop</customer_words>'
        assert "deviceType" not in state["missing"]
        started = [e.payload["returning"] for e in await list_events(db.pool, id_) if e.type == "call.started"]
        assert started == [False, True]
        await second.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 2), "second call ended")


class TestP5ReviewFixesSocket:
    async def test_4_shutdown_settle_calls_waits_for_end_call_to_commit_even_when_a_provider_is_slow_to_close(
        self, rig
    ):
        db = rig.db
        rig.fresh()
        doomed = await start_app(db, services=rig.services, voice=rig.deps())
        id_ = await seed_session(db.pool)
        await open_call(id_, doomed)
        await wait_for(lambda: len(rig.stt.streams) == 1, "STT")
        rig.stt.current.close_delay_ms = 800
        await doomed.close()
        assert await settle_calls(doomed.runtime.calls, 3_000) is True
        assert await ended(db, id_) == ["server_restart"]
        assert (await get_session(db.pool, id_)).active_call_id is None

    async def test_12_mic_frames_faster_than_real_time_are_dropped_beyond_a_2_s_burst(self, rig):
        db = rig.db
        id_ = await seed_session(db.pool)
        socket = await open_call(id_, rig.server)
        await wait_for(lambda: len(rig.stt.streams) == 1, "STT")
        for _ in range(400):
            await socket.send(bytes(640))  # 8 s of audio at once
        await asyncio.sleep(0.3)
        frames = rig.stt.current.bytes / 640
        assert frames >= 100
        assert frames < 130  # the burst, plus what refilled meanwhile
        await socket.close(1000)
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")


class TestAHangUpWhileTheProvidersAreStillOpening:
    async def test_ends_with_reason_hangup_not_network(self, rig):
        db = rig.db
        rig.stt.open_delay_ms = 400
        id_ = await seed_session(db.pool)
        socket = await open_call(id_, rig.server)
        await wait_for(lambda: call_started(db, id_), "call started")
        await socket.close(1000)  # before the STT has opened
        await wait_for(lambda: _len_is(ended(db, id_), 1), "call.ended")
        assert await ended(db, id_) == ["hangup"]


async def call_slots_free(app: Any) -> bool:
    """Every call has fully ended: the instance's slot and each session's slot are free again."""
    return app.runtime.calls.size == 0 and not app.runtime.call_state.sessions_in_call


async def _len_is(awaitable: Any, n: int) -> bool:
    return len(await awaitable) == n


async def _at_least(awaitable: Any, n: int) -> bool:
    return len(await awaitable) >= n


_ = RawSocket  # re-exported client type, kept for readers of the network-loss test
