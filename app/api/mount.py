"""Mounts the plain HTTP API on a FastAPI app, in the order that makes the 404 policy and the headers right.

`create_http_app()` builds the FastAPI instance (no OpenAPI docs: the UI's own paths must not be shadowed); the
WebSocket routes (`/chat`, `/call`) are added by the caller before or after: they are a different ASGI scope and never
meet the HTTP catch-all.

    app = create_http_app()
    mount_http_routes(app, db=db, public_origin=..., signer=..., session_limiter=..., processor=..., quota=...)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI

from app.config import Secret
from app.db.pool import Database
from app.files.signing import FileUrlSigner
from app.files.storage import DEFAULT_UPLOAD_BUDGET_BYTES
from app.limits.quota_guard import QuotaGuard
from app.limits.routes import quota_router
from app.session.commands import CommandProcessor
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import NewSessionSettings

from .client_ip import make_client_ip
from .errors import register_error_handlers
from .files import files_router
from .health import health_router
from .hooks import hooks_router
from .security import register_security_headers, security_headers
from .sessions import session_read_router, test_session_router
from .web import DEFAULT_WEB_DIST, register_web


def create_http_app(**kwargs: Any) -> FastAPI:
    """A FastAPI app with the interactive docs and OpenAPI routes switched off."""
    return FastAPI(docs_url=None, redoc_url=None, openapi_url=None, **kwargs)


def mount_http_routes(
    app: FastAPI,
    *,
    db: Database,
    public_origin: str,
    log: Any = None,
    web_dist_dir: Path | str = DEFAULT_WEB_DIST,
    require_web_build: bool = False,
    trust_proxy_hops: int = 0,
    api_rate_limit_per_minute: int = 60,
    signer: FileUrlSigner | None = None,
    upload_budget_bytes: int = DEFAULT_UPLOAD_BUDGET_BYTES,
    session_limiter: CreationLimiter | None = None,
    new_session: NewSessionSettings | None = None,
    max_concurrent_uploads: int = 2,
    uploads_per_minute: int = 30,
    downloads_per_minute: int = 120,
    upload_bytes_per_ip_per_hour: int = 100 * 1024 * 1024,
    upload_deadline_ms: float = 60_000,
    quota: QuotaGuard | None = None,
    test_api_token: Secret | None = None,
    hook_secret: Secret | None = None,
    processor: CommandProcessor | None = None,
) -> None:
    """Registers, in order: error handlers and security headers, /healthz and /readyz, the session read API, uploads and
    signed downloads (only with a `signer`, i.e. FILE_URL_SECRET), the quota override (only when `quota.can_override`),
    the test API (only with `test_api_token`; needs `processor`), the hook receiver (only with `hook_secret`), and last
    the web UI with the 404 policy (`require_web_build` raises when `web_dist_dir` has no build)."""
    client_ip = make_client_ip(trust_proxy_hops)
    register_error_handlers(app, security_headers=security_headers(public_origin))
    register_security_headers(app, public_origin)
    app.include_router(health_router(db=db, log=log))
    app.include_router(
        session_read_router(pool=db.pool, per_minute=api_rate_limit_per_minute, client_ip=client_ip, log=log)
    )
    if signer is not None:
        if session_limiter is None:
            raise ValueError("session_limiter is required with a signer (uploads create sessions)")
        app.include_router(
            files_router(
                pool=db.pool,
                signer=signer,
                budget_bytes=upload_budget_bytes,
                session_limiter=session_limiter,
                new_session=new_session,
                max_concurrent_uploads=max_concurrent_uploads,
                uploads_per_minute=uploads_per_minute,
                downloads_per_minute=downloads_per_minute,
                upload_bytes_per_ip_per_hour=upload_bytes_per_ip_per_hour,
                upload_deadline_ms=upload_deadline_ms,
                client_ip=client_ip,
                log=log,
            )
        )
    if quota is not None and quota.can_override:
        app.include_router(quota_router(guard=quota, client_ip=client_ip, log=log))
    if test_api_token is not None:
        if processor is None:
            raise ValueError("processor is required with test_api_token (the finalize route dispatches through it)")
        app.include_router(
            test_session_router(
                pool=db.pool, test_api_token=test_api_token, processor=processor, new_session=new_session, log=log
            )
        )
    if hook_secret is not None:
        app.include_router(hooks_router(pool=db.pool, hook_secret=hook_secret, test_api_token=test_api_token, log=log))
    register_web(app, dist_dir=web_dist_dir, require_build=require_web_build, log=log)
