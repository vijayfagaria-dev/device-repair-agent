"""Health endpoints (D09, D18).

/healthz: liveness for the uptime monitor. It never touches the database, so pings don't keep Neon awake.
/readyz: database reachability, for deploy health checks only.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.db.pool import Database


def health_router(*, db: Database, log: Any = None) -> APIRouter:
    logger = log if log is not None else structlog.get_logger()
    router = APIRouter()

    @router.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok"}, headers={"cache-control": "no-store"})

    @router.get("/readyz")
    async def readyz() -> JSONResponse:
        headers = {"cache-control": "no-store"}
        try:
            await db.pool.fetchval("SELECT 1")
        except Exception as err:
            logger.warning(
                "database not ready",
                code=getattr(err, "sqlstate", None) or getattr(err, "code", None),
                err=str(err),
            )
            return JSONResponse({"status": "unavailable"}, status_code=503, headers=headers)
        return JSONResponse({"status": "ok"}, headers=headers)

    return router
