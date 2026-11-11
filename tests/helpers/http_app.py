"""An ASGI test client over an app built from the plain HTTP routers (the TS tests' `buildApp` + `inject`)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import FastAPI

from app.api.mount import create_http_app, mount_http_routes
from app.db.pool import Database
from app.logging import create_logger
from app.session.creation_limit import CreationLimiter

ORIGIN = "https://repair.example.com"


def build_http_app(db: Database, **options: Any) -> FastAPI:
    """`mount_http_routes` on a fresh app with a silent logger, a missing web build and the test origin by default."""
    settings: dict[str, Any] = {"log": create_logger("silent"), "public_origin": ORIGIN, "require_web_build": False}
    settings.update(options)
    settings.setdefault("web_dist_dir", "/nonexistent")
    settings.setdefault("session_limiter", CreationLimiter(max=1000, window_ms=60 * 60 * 1000))
    app = create_http_app()
    mount_http_routes(app, db=db, **settings)
    return app


def client_for(app: FastAPI, *, remote: str = "127.0.0.1") -> httpx.AsyncClient:
    """An httpx client calling the app in-process (an unhandled error becomes the app's 500, as over a socket)."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(remote, 50_000))
    return httpx.AsyncClient(transport=transport, base_url=ORIGIN)
