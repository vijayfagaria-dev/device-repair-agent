"""The app: configuration -> database -> migrations -> services -> quota guard -> sweeper -> outbox worker -> HTTP
routers -> WebSockets -> static web UI, with a FastAPI lifespan that starts and stops the background pieces
(server/src/app.ts + index.ts).

Entry points:

    uv run python -m app                            # reads the environment, listens on HOST:PORT (app/__main__.py)
    uvicorn app.main:create_app --factory           # the standard FastAPI way; `app.main:app` works too (lazy)

`create_app(config)` builds everything the process needs; tests inject fake providers (``providers=``) and an already
migrated database (``db=``). `build_app(...)` is the pure app (routes, sockets, services; no lifecycle), the TS `buildApp`.
"""

from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI

from app.agent.llm import create_llm_router, llm_hops
from app.api.mount import create_http_app, mount_http_routes
from app.api.web import DEFAULT_WEB_DIST
from app.boot.recover import recover_on_boot
from app.boot.shutdown import ShutdownDeps, create_shutdown
from app.config import Config, ConfigError, Secret, load_config
from app.db.migrate import migrate_at_boot
from app.db.pool import Database, create_database
from app.delivery.worker import OutboxWorker
from app.files.signing import FileUrlSigner, create_file_url_signer
from app.files.storage import DEFAULT_UPLOAD_BUDGET_BYTES
from app.jobs.sweeper import Sweeper
from app.limits.quota_guard import QuotaGuard, QuotaSettings
from app.logging import create_logger
from app.session.commands import TimerSettings
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import DEFAULT_NO_CALL_START_MS, NewSessionSettings
from app.session.services import SessionServices, create_session_services
from app.voice.call_engine import CallTimings
from app.voice.clock import Clock
from app.voice.deepgram import create_deepgram_stt
from app.voice.deepgram_tts import create_deepgram_tts
from app.ws.call import Providers, VoiceDeps, settle_calls
from app.ws.keep_alive import CALL_KEEPALIVE, KeepAliveOptions, uvicorn_ws_options
from app.ws.plugin import SHUTDOWN_CLOSE_GRACE_MS, WebSocketRuntime, mount_websockets

HOUR_MS = 60 * 60 * 1000

__all__ = [
    "AppServer",
    "build_app",
    "create_app",
    "file_url_signer",
    "providers_from_config",
    "run",
]


def file_url_signer(
    *, file_url_secret: Secret | None, public_origin: str, file_url_ttl_seconds: int | None = None
) -> FileUrlSigner | None:
    """The file-link signer for this configuration, or None when FILE_URL_SECRET isn't set."""
    if file_url_secret is None:
        return None
    return create_file_url_signer(secret=file_url_secret, public_origin=public_origin, ttl_seconds=file_url_ttl_seconds)


class _DeferredPool:
    """The pool a factory-built app is wired with before the event loop exists; the lifespan binds the real one."""

    def __init__(self) -> None:
        self._pool: Any = None

    def bind(self, pool: Any) -> None:
        self._pool = pool

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__") or self._pool is None:
            raise AttributeError(f"the database pool is not open yet ({name})")
        return getattr(self._pool, name)


def build_app(
    *,
    log: Any,
    db: Database,
    public_origin: str,
    web_dist_dir: Path | str = DEFAULT_WEB_DIST,
    require_web_build: bool = False,
    trust_proxy_hops: int = 0,
    new_sessions_per_ip_per_hour: int = 20,
    test_api_token: Secret | None = None,
    hook_secret: Secret | None = None,
    services: SessionServices | None = None,
    api_rate_limit_per_minute: int = 60,
    voice: VoiceDeps | None = None,
    file_url_secret: Secret | None = None,
    file_url_ttl_seconds: int | None = None,
    upload_budget_bytes: int = DEFAULT_UPLOAD_BUDGET_BYTES,
    no_call_start_ms: float = DEFAULT_NO_CALL_START_MS,
    max_concurrent_uploads: int = 2,
    uploads_per_minute: int = 30,
    downloads_per_minute: int = 120,
    upload_bytes_per_ip_per_hour: int = 100 * 1024 * 1024,
    upload_deadline_ms: float = 60_000,
    quota: QuotaGuard | None = None,
    auto_complete_on_idle: bool = True,
    timers: TimerSettings | None = None,
    **fastapi_options: Any,
) -> FastAPI:
    """The HTTP routes, the sockets and the session services on a FastAPI app, without listening or starting anything.

    `services`: the hub and command processor; created here when not given. `voice`: the call's providers and limits
    (without them /call refuses with 1011). `file_url_secret`: enables uploads and signed downloads. `quota`: the
    free-tier quota guard, used for `voiceAvailable` and the override route. `test_api_token` / `hook_secret` enable the
    test API and the stub record receiver. Extra keyword arguments go to the `FastAPI` constructor (the lifespan).
    The WebSocket runtime is `app.state.ws_runtime`, the services `app.state.services`."""
    signer = file_url_signer(
        file_url_secret=file_url_secret, public_origin=public_origin, file_url_ttl_seconds=file_url_ttl_seconds
    )
    if services is None:
        services = create_session_services(
            pool=db.pool,
            log=log,
            timers=timers,
            sign_file_url=signer.sign if signer else None,
            auto_complete_on_idle=auto_complete_on_idle,
        )
    processor = services.processor
    # A new session's noCallStart timer (P4-T04) reaches the sweeper the same way a command's timers do.
    new_session = NewSessionSettings(
        no_call_start_ms=no_call_start_ms, on_timer_scheduled=lambda due_at: processor.timer_scheduled(due_at)
    )
    session_limiter = CreationLimiter(max=new_sessions_per_ip_per_hour, window_ms=HOUR_MS)

    app = create_http_app(**fastapi_options)
    app.state.services = services
    app.state.db = db
    app.state.log = log
    app.state.ws_runtime = mount_websockets(
        app,
        pool=db.pool,
        public_origin=public_origin,
        session_limiter=session_limiter,
        services=services,
        log=log,
        new_session=new_session,
        voice=voice,
        quota=quota,
        trust_proxy_hops=trust_proxy_hops,
    )
    mount_http_routes(
        app,
        db=db,
        public_origin=public_origin,
        log=log,
        web_dist_dir=web_dist_dir,
        require_web_build=require_web_build,
        trust_proxy_hops=trust_proxy_hops,
        api_rate_limit_per_minute=api_rate_limit_per_minute,
        signer=signer,
        upload_budget_bytes=upload_budget_bytes,
        session_limiter=session_limiter,
        new_session=new_session,
        max_concurrent_uploads=max_concurrent_uploads,
        uploads_per_minute=uploads_per_minute,
        downloads_per_minute=downloads_per_minute,
        upload_bytes_per_ip_per_hour=upload_bytes_per_ip_per_hour,
        upload_deadline_ms=upload_deadline_ms,
        quota=quota,
        test_api_token=test_api_token,
        hook_secret=hook_secret,
        processor=processor,
    )
    return app


def providers_from_config(config: Config, log: Any) -> Providers:
    """The call's real providers (P5): Deepgram STT and Aura-2 over WebSockets, the LLM through the fallback chain (D06)."""
    stt = create_deepgram_stt(api_key=config.deepgram_api_key)
    tts = create_deepgram_tts(api_key=config.deepgram_api_key, voice=config.tts_voice)
    llm = create_llm_router(
        hops=llm_hops(groq_api_key=config.groq_api_key, gemini_api_key=config.gemini_api_key, models=config.llm_routes),
        on_hop_failed=lambda route, error: log.warning(
            "LLM route failed; trying the next", provider=route.provider, model=route.model, status=error.status
        ),
    )
    return Providers(stt=stt, tts=tts, llm=llm)


def create_app(
    config: Config | None = None,
    *,
    providers: Providers | Callable[[], Providers] | None = None,
    db: Database | None = None,
    log: Any = None,
    services: SessionServices | None = None,
    web_dist_dir: Path | str = DEFAULT_WEB_DIST,
    clock: Clock | None = None,
    timings: CallTimings | None = None,
    keep_alive: KeepAliveOptions | None = None,
    migrate: bool | None = None,
    recover: bool = True,
    background: bool = True,
    **overrides: Any,
) -> FastAPI:
    """The whole server from a `Config` (default: the environment).

    `providers`: the call's STT/TTS/LLM (or a function returning them); default: the real ones built from the config.
    `db`: an open (and migrated) database, which the app then does not own or close; default: opened from DATABASE_URL by
    the lifespan, migrated (`migrate`), and closed last at shutdown. `recover`: run boot recovery before the server
    takes traffic. `background`: run the sweeper and the outbox worker. `overrides`: any `build_app` argument.

    The lifespan runs: open the database -> migrations -> sweeper start and boot recovery (dangling calls, outbox leases,
    overdue timers, reconciliation, orphaned uploads) -> outbox worker; and on shutdown the steps of boot.shutdown."""
    cfg = config if config is not None else load_config()
    logger = log if log is not None else create_logger(cfg.log_level)
    owns_db = db is None
    deferred = _DeferredPool()
    database = db if db is not None else Database(pool=deferred)  # type: ignore[arg-type]
    run_migrations = owns_db if migrate is None else migrate

    if providers is None:
        make_providers: Callable[[], Providers] = lambda: real_providers  # noqa: E731
        real_providers = providers_from_config(cfg, logger)
    elif callable(providers):
        make_providers = providers
    else:
        fixed = providers
        make_providers = lambda: fixed  # noqa: E731

    quota = QuotaGuard(
        database.pool,
        QuotaSettings(
            llm_requests_per_day=cfg.daily_llm_request_budget,
            audio_minutes_per_day=cfg.daily_audio_minutes_budget,
            override_token=cfg.quota_override_token,
        ),
        logger.bind(component="quota"),
    )
    voice = VoiceDeps(
        providers=make_providers,
        max_concurrent_calls=cfg.max_concurrent_calls,
        clock=clock,
        timings=timings or CallTimings(max_call_ms=cfg.max_call_seconds * 1000),
        keep_alive=keep_alive,
        quota=quota,
    )
    components: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            if owns_db:
                opened = await create_database(
                    cfg.database_url.reveal(),
                    on_error=lambda err: logger.error(
                        "idle database connection failed", code=getattr(err, "sqlstate", None), message=str(err)
                    ),
                )
                deferred.bind(opened.pool)
                database.stats = opened.stats
            if run_migrations:
                result = await migrate_at_boot(database.pool, logger)
                logger.info("migrations complete", applied=result.applied, count=len(result.applied))
            sweeper = Sweeper(
                pool=database.pool,
                processor=app.state.services.processor,
                log=logger.bind(component="sweeper"),
            )
            app.state.services.processor.on_timer_scheduled = sweeper.notify
            components["sweeper"] = sweeper
            if recover:
                # Boot recovery runs before the server listens: dangling calls, overdue timers (the sweeper starts
                # here), reconciliation of every active session, orphaned uploads.
                await recover_on_boot(
                    pool=database.pool, processor=app.state.services.processor, sweeper=sweeper, log=logger
                )
            elif background:
                await sweeper.start()
            if background:
                await _start_outbox(app, cfg, database, logger, components)
        except BaseException as err:
            logger.fatal("server failed to start", err=repr(err))
            if owns_db and deferred._pool is not None:
                await deferred._pool.close()
            raise
        try:
            yield
        finally:
            await _shutdown(app, database, components, logger, owns_db, deferred)

    app = build_app(
        log=logger,
        db=database,
        public_origin=cfg.public_origin,
        web_dist_dir=web_dist_dir,
        require_web_build=cfg.env == "production",
        trust_proxy_hops=cfg.trust_proxy_hops,
        new_sessions_per_ip_per_hour=cfg.new_sessions_per_ip_per_hour,
        test_api_token=cfg.test_api_token,
        hook_secret=cfg.hook_secret,
        services=services,
        voice=voice,
        file_url_secret=cfg.file_url_secret,
        file_url_ttl_seconds=cfg.file_url_ttl_seconds,
        upload_budget_bytes=cfg.upload_budget_bytes,
        quota=quota,
        auto_complete_on_idle=cfg.auto_complete_on_idle,
        timers=TimerSettings(
            idle_timeout_ms=cfg.idle_timeout_seconds * 1000, session_lifetime_ms=cfg.session_lifetime_seconds * 1000
        ),
        lifespan=lifespan,
        **overrides,
    )
    app.state.config = cfg
    app.state.keep_alive = keep_alive or CALL_KEEPALIVE
    return app


async def _start_outbox(app: FastAPI, cfg: Config, database: Database, log: Any, components: dict[str, Any]) -> None:
    """The outbox worker (D17). Its default target is this very server's stub receiver, called in-process (no socket)."""
    client: httpx.AsyncClient | None = None
    if cfg.record_webhook_url is not None:
        url = cfg.record_webhook_url
    else:
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), follow_redirects=False)
        url = Secret("http://localhost/hooks/records")
        components["outbox_client"] = client
    outbox = OutboxWorker(
        pool=database.pool, log=log.bind(component="outbox"), url=url, hook_secret=cfg.hook_secret, client=client
    )
    app.state.services.processor.on_outbox_queued = outbox.notify
    components["outbox"] = outbox
    await outbox.start()


async def _shutdown(
    app: FastAPI, database: Database, components: dict[str, Any], log: Any, owns_db: bool, deferred: _DeferredPool
) -> None:
    """The graceful shutdown (P8-T02), in order, inside one hard limit; the pool only when this app opened it."""
    runtime: WebSocketRuntime = app.state.ws_runtime
    sweeper: Sweeper | None = components.get("sweeper")
    outbox: OutboxWorker | None = components.get("outbox")
    client: httpx.AsyncClient | None = components.get("outbox_client")

    async def stop_outbox() -> None:
        if outbox is not None:
            await outbox.stop()
        if client is not None:
            await client.aclose()

    async def stop_sweeper() -> None:
        if sweeper is not None:
            await sweeper.stop()

    async def close_pool() -> None:
        if owns_db and deferred._pool is not None:
            await deferred._pool.close()

    shutdown = create_shutdown(
        ShutdownDeps(
            log=log,
            close_server=lambda: runtime.close_sockets(SHUTDOWN_CLOSE_GRACE_MS),
            settle_calls=lambda: settle_calls(runtime.calls),
            stop_sweeper=stop_sweeper,
            drain_commands=app.state.services.processor.drain,
            stop_outbox=stop_outbox,
            close_pool=close_pool,
            exit=lambda code: os._exit(code) if code != 0 else None,
        )
    )
    await shutdown("lifespan")


class AppServer(uvicorn.Server):
    """uvicorn's server with the shutdown order of boot.shutdown: before uvicorn closes anything, every open socket gets
    its `closing` message and a 1012 close (so /chat reconnects and replays, and every call ends `server_restart`);
    clients that don't answer within the grace period are dropped, so shutdown stays well inside the 10 s limit."""

    def __init__(self, config: uvicorn.Config, app: FastAPI) -> None:
        super().__init__(config)
        self._fastapi = app

    async def startup(self, sockets: Any = None) -> None:
        await super().startup(sockets)
        if self.started and self.servers:
            host, port = self.servers[0].sockets[0].getsockname()[:2]
            self._fastapi.state.log.info("server listening", address=f"http://{host}:{port}", port=port)

    async def shutdown(self, sockets: Any = None) -> None:
        runtime: WebSocketRuntime = self._fastapi.state.ws_runtime
        await runtime.close_sockets(SHUTDOWN_CLOSE_GRACE_MS)
        for connection in list(self.server_state.connections):
            if "WebSocket" in type(connection).__name__:
                transport = getattr(connection, "transport", None)
                if transport is not None:
                    transport.abort()
        await super().shutdown(sockets)


def _app_keep_alive(app: FastAPI) -> KeepAliveOptions:
    found: KeepAliveOptions | None = getattr(app.state, "keep_alive", None)
    return found or CALL_KEEPALIVE


def server_config(
    app: FastAPI,
    *,
    host: str,
    port: int,
    keep_alive: KeepAliveOptions | None = None,
    lifespan: str = "on",
    **extra: Any,
) -> uvicorn.Config:
    """The uvicorn settings for this app: no access log (the app logs what matters), the sockets' keepalive and size limit,
    and no `X-Forwarded-*` rewriting (the app trusts proxy hops itself, TRUST_PROXY_HOPS; uvicorn would believe a header
    from 127.0.0.1 whatever that says). Graceful shutdown waits at most 5 s for connections."""
    settings: dict[str, Any] = {
        "log_config": None,
        "access_log": False,
        "proxy_headers": False,
        "timeout_graceful_shutdown": 5,
        **uvicorn_ws_options(keep_alive or _app_keep_alive(app)),
        **extra,
    }
    return uvicorn.Config(app, host=host, port=port, lifespan=lifespan, **settings)  # type: ignore[arg-type]


def run(env: dict[str, str | None] | None = None) -> int:
    """Validates the configuration, builds the app and serves it until SIGTERM/SIGINT. Returns the exit code."""
    try:
        config = load_config(env if env is not None else os.environ)  # type: ignore[arg-type]
    except ConfigError as err:
        # Names and expectations only; ConfigError never contains a value.
        create_logger("info").fatal(
            err.args[0], problems=[{"name": p.name, "problem": p.problem} for p in err.problems]
        )
        return 1
    log = create_logger(config.log_level)
    try:
        app = create_app(config, log=log)
        server = AppServer(server_config(app, host=config.host, port=config.port), app)
        server.run()
    except SystemExit as exit_:
        return int(exit_.code or 0) if isinstance(exit_.code, int) else 1
    except Exception as err:
        log.fatal("server failed to start", err=repr(err))
        return 1
    return 0 if server.started else 1


_lazy_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    """`uvicorn app.main:app`: the app, built from the environment on first access."""
    global _lazy_app
    if name == "app":
        if _lazy_app is None:
            _lazy_app = create_app()
        return _lazy_app
    raise AttributeError(name)


if __name__ == "__main__":
    sys.exit(run())
