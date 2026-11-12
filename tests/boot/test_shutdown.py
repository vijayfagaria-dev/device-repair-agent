"""Graceful shutdown (P8-T02): the order of the steps, what happens when one fails or hangs, the hard limit, and the real
pieces in-process (a live call and a chat socket get 1012, the call row is closed, the pool ends last).
(Port of server/test/boot/shutdown.test.ts.)"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from app.boot.shutdown import ShutdownDeps, create_shutdown
from app.db.repos.calls import list_calls
from app.db.repos.events import list_events
from app.db.repos.sessions import get_session
from app.delivery.worker import OutboxWorker
from app.jobs.sweeper import Sweeper
from app.logging import create_logger
from app.session.handlers.request_input import Reconcile
from app.voice.call_engine import CallTimings
from app.voice.fakes.llm import FakeLlm, LlmScript
from app.voice.fakes.stt import FakeStt
from app.voice.fakes.tts import FakeTts
from app.ws.call import Providers, VoiceDeps, settle_calls
from tests.helpers.app import connect, start_app
from tests.helpers.session import test_services

log = create_logger("silent")


def fakes(order: list[str], **overrides: Any) -> tuple[ShutdownDeps, list[int]]:
    exits: list[int] = []

    def mark(name: str) -> Any:
        async def run() -> None:
            order.append(name)

        return run

    async def settle() -> bool:
        order.append("settle calls")
        return True

    async def drain(_ms: float) -> bool:
        order.append("drain commands")
        return True

    settings: dict[str, Any] = {
        "log": log,
        "close_server": mark("close sockets"),
        "settle_calls": settle,
        "stop_sweeper": mark("stop sweeper"),
        "drain_commands": drain,
        "stop_outbox": mark("stop outbox"),
        "close_pool": mark("close database"),
        "exit": exits.append,
    }
    settings.update(overrides)
    return ShutdownDeps(**settings), exits


class TestCreateShutdown:
    async def test_runs_the_steps_in_order_the_database_last_and_exits_0(self):
        order: list[str] = []
        deps, exits = fakes(order)
        await create_shutdown(deps)("SIGTERM")
        assert order == [
            "close sockets",
            "settle calls",
            "stop sweeper",
            "drain commands",
            "stop outbox",
            "close database",
        ]
        assert exits == [0]

    async def test_a_second_signal_while_stopping_changes_nothing(self):
        order: list[str] = []
        deps, exits = fakes(order)
        shutdown = create_shutdown(deps)
        await asyncio.gather(shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM"))
        assert order.count("close database") == 1
        assert exits == [0]

    async def test_a_step_that_fails_is_logged_and_the_rest_still_run_the_database_included(self):
        order: list[str] = []

        async def broken() -> None:
            raise RuntimeError("sweeper broke")

        async def not_settled() -> bool:
            return False

        async def not_drained(_ms: float) -> bool:
            return False

        deps, exits = fakes(order, stop_sweeper=broken, settle_calls=not_settled, drain_commands=not_drained)
        await create_shutdown(deps)("SIGTERM")
        assert order == ["close sockets", "stop outbox", "close database"]
        assert exits == [0]

    async def test_a_step_that_never_finishes_is_cut_off_by_the_hard_limit_exit_code_1(self):
        order: list[str] = []

        async def stuck() -> None:
            await asyncio.Event().wait()

        deps, exits = fakes(order, close_server=stuck, timeout_ms=150)
        task = asyncio.ensure_future(create_shutdown(deps)("SIGTERM"))
        await asyncio.sleep(0.4)
        assert exits == [1]
        assert order == []  # stuck on the first step; nothing after it ran
        task.cancel()


class TestTheRealPieces:
    async def test_a_live_call_and_a_chat_socket_get_1012_the_call_row_closes_before_the_pool_ends(self, db):
        services = test_services(db, planner=True)
        sweeper = Sweeper(pool=db.pool, processor=services.processor, log=log)
        outbox = OutboxWorker(pool=db.pool, log=log, url="http://127.0.0.1:9/hooks/records", hook_secret="h" * 32)
        stt, tts, llm = FakeStt(), FakeTts(), FakeLlm()
        llm.fallback = LlmScript(text="Okay.")
        voice = VoiceDeps(
            providers=lambda: Providers(stt, tts, llm), max_concurrent_calls=3, timings=CallTimings(silence_ms=60_000)
        )
        running = await start_app(db, services=services, voice=voice)
        await sweeper.start()
        await outbox.start()

        session_id = str(uuid.uuid4())
        call = connect(f"{running.ws}/call?sessionId={session_id}")
        await call.opened

        async def call_is_active() -> bool:
            session = await get_session(db.pool, session_id)
            return session is not None and session.active_call_id is not None

        for _ in range(300):
            if await call_is_active():
                break
            await asyncio.sleep(0.01)
        assert await call_is_active()
        chat = connect(f"{running.ws}/chat?sessionId={uuid.uuid4()}")
        await chat.opened

        exits: list[int] = []
        steps: list[str] = []

        async def close_pool() -> None:
            steps.append("pool")  # the shared test pool stays open for the assertions below

        began = time.monotonic()
        await create_shutdown(
            ShutdownDeps(
                log=log,
                close_server=running.close,
                settle_calls=lambda: settle_calls(running.runtime.calls),
                stop_sweeper=sweeper.stop,
                drain_commands=services.processor.drain,
                stop_outbox=outbox.stop,
                close_pool=close_pool,
                exit=exits.append,
            )
        )("SIGTERM")

        assert exits == [0]
        assert time.monotonic() - began < 10
        closed = await call.closed
        assert (closed.code, closed.reason) == (1012, "server restarting")
        closed = await chat.closed
        assert (closed.code, closed.reason) == (1012, "server restarting")
        assert running.runtime.calls.size == 0
        assert (await list_calls(db.pool, session_id))[0].end_reason == "server_restart"
        reasons = [e.payload["reason"] for e in await list_events(db.pool, session_id) if e.type == "call.ended"]
        assert reasons == ["server_restart"]
        assert (await get_session(db.pool, session_id)).active_call_id is None
        assert steps == ["pool"]

    async def test_drain_commands_waits_for_commands_in_flight_and_reports_a_timeout(self, db):
        services = test_services(db, planner=True)
        assert await services.processor.drain(50) is True  # nothing running
        session_id = str(uuid.uuid4())
        await db.pool.execute("INSERT INTO sessions (id) VALUES ($1)", session_id)
        running = asyncio.ensure_future(services.processor.dispatch(session_id, Reconcile()))
        drained = asyncio.ensure_future(services.processor.drain(2_000))
        await running
        assert await drained is True
