"""Graceful shutdown (P8-T02). Every deploy restarts the server, so a clean stop must not leave a call half-open or lose
a write. Order, all inside one hard limit (default 10 s, Render's documented default grace is 30 s):

 1. stop accepting and close the sockets: /call and /chat get 1012 "server restarting" (ws.plugin)
 2. let every call finish ending: its EndCall must commit before the pool closes (settle_calls)
 3. stop the sweeper (the only background source of commands), then drain the commands still in flight
 4. stop the outbox worker (an unfinished delivery keeps its lease and is redelivered after a restart)
 5. end the database pool last

A step that fails or times out is logged and the next one still runs; only the hard limit forces exit code 1.
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

SHUTDOWN_TIMEOUT_MS = 10_000


@dataclass(slots=True)
class ShutdownDeps:
    log: Any
    #: Stops accepting and closes the sockets.
    close_server: Callable[[], Awaitable[Any]]
    #: Resolves True when every call has finished ending.
    settle_calls: Callable[[], Awaitable[bool]]
    stop_sweeper: Callable[[], Awaitable[Any]]
    drain_commands: Callable[[float], Awaitable[bool]]
    stop_outbox: Callable[[], Awaitable[Any]]
    #: Ends the database pool (the last step).
    close_pool: Callable[[], Awaitable[Any]]
    #: The hard limit for the whole shutdown (default 10 s).
    timeout_ms: float = SHUTDOWN_TIMEOUT_MS
    #: How long the command drain may take (default 3 s).
    drain_ms: float = 3_000
    exit: Callable[[int], None] | None = None


def _exit_process(code: int) -> None:
    os._exit(code)


def create_shutdown(deps: ShutdownDeps) -> Callable[[str], Awaitable[None]]:
    """The shutdown routine: `await shutdown("SIGTERM")`. It runs once; a second signal while stopping changes nothing."""
    log = deps.log
    exit_ = deps.exit or _exit_process
    started = False

    async def step(name: str, run: Callable[[], Awaitable[Any]]) -> Any:
        began = time.monotonic()
        try:
            result = await run()
        except Exception as err:
            log.error("shutdown step failed", step=name, err=repr(err))
            return None
        log.info("shutdown step done", step=name, ms=round((time.monotonic() - began) * 1000))
        return result

    async def shutdown(signal_name: str) -> None:
        nonlocal started
        if started:
            return
        started = True
        log.info("shutting down", signal=signal_name)

        def timed_out() -> None:
            log.error("shutdown timed out", timeout_ms=deps.timeout_ms)
            exit_(1)

        force = asyncio.get_running_loop().call_later(deps.timeout_ms / 1000, timed_out)

        await step("close sockets", deps.close_server)
        if await step("settle calls", deps.settle_calls) is False:
            log.warning("calls still ending at shutdown")
        await step("stop sweeper", deps.stop_sweeper)
        if await step("drain commands", lambda: deps.drain_commands(deps.drain_ms)) is False:
            log.warning("commands still running at shutdown")
        await step("stop outbox", deps.stop_outbox)
        await step("close database", deps.close_pool)

        force.cancel()
        log.info("shutdown complete")
        exit_(0)

    return shutdown


def install_signal_handlers(shutdown: Callable[[str], Awaitable[None]]) -> None:
    """SIGTERM (a deploy) and SIGINT (Ctrl-C) start the shutdown once."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig: asyncio.ensure_future(shutdown(s.name)))
