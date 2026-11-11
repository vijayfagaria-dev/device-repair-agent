"""POST /api/quota/override (P10-T03): the owner lifts the quota guard for 24 h with `Authorization: Bearer
<QUOTA_OVERRIDE_TOKEN>`. Registered only when the token is configured; heavily rate-limited, because it is a secret
check on a public URL. Responses never reveal whether a token is configured elsewhere.
"""

from __future__ import annotations

import re
from typing import Any

import structlog
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.api.client_ip import ClientIp, peer_ip
from app.api.rate_limit import RateLimiter, rate_limit_dependency

from .quota_guard import QuotaGuard

_BEARER = re.compile(r"Bearer (.+)")


def quota_router(*, guard: QuotaGuard, client_ip: ClientIp = peer_ip, log: Any = None) -> APIRouter:
    """The override route. Mount it only when `guard.can_override`."""
    logger = log if log is not None else structlog.get_logger()
    router = APIRouter()
    limit = rate_limit_dependency(
        RateLimiter(5, 60_000),
        refusal=lambda _decision: ({"error": "rate_limited", "message": "Too many attempts."}, {}),
        client_ip=client_ip,
        log=logger,
    )

    @router.post("/api/quota/override", dependencies=[Depends(limit)])
    async def override(request: Request) -> JSONResponse:
        match = _BEARER.fullmatch(request.headers.get("authorization", ""))
        token = match.group(1) if match else None
        if not token or not guard.override(token):
            logger.warning("quota override refused")
            return JSONResponse({"error": "unauthorized"}, status_code=401, headers={"cache-control": "no-store"})
        return JSONResponse({"overridden": True}, headers={"cache-control": "no-store"})

    return router
