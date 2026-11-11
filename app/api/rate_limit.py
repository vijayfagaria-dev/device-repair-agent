"""Per-key fixed-window rate limits in memory (the semantics of @fastify/rate-limit's local store).

The window starts at a key's first request; the `max + 1`th request inside it is refused until the window ends.
Headers `x-ratelimit-*` ride on every answer and `retry-after` on a refusal.
"""

from __future__ import annotations

import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import structlog
from fastapi import Request, Response

from .client_ip import ClientIp, peer_ip
from .errors import HttpError


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    limit: int
    remaining: int
    #: Milliseconds until the window ends.
    ttl_ms: int


class RateLimiter:
    def __init__(self, max_requests: int, window_ms: float = 60_000, now: Callable[[], float] | None = None) -> None:
        self.max = max_requests
        self.window_ms = window_ms
        self._now = now or (lambda: time.monotonic() * 1000)
        self._hits: dict[str, tuple[int, float]] = {}
        self._last_purge = self._now()

    def hit(self, key: str) -> RateDecision:
        now = self._now()
        if now - self._last_purge >= self.window_ms:
            self._last_purge = now
            self._hits = {k: v for k, v in self._hits.items() if v[1] > now}
        count, expires = self._hits.get(key, (0, 0.0))
        if expires <= now:
            count, expires = 0, now + self.window_ms
        count += 1
        self._hits[key] = (count, expires)
        ttl = max(0, int(expires - now))
        return RateDecision(allowed=count <= self.max, limit=self.max, remaining=max(0, self.max - count), ttl_ms=ttl)


def rate_headers(decision: RateDecision) -> dict[str, str]:
    headers = {
        "x-ratelimit-limit": str(decision.limit),
        "x-ratelimit-remaining": str(decision.remaining),
        "x-ratelimit-reset": str(math.ceil(decision.ttl_ms / 1000)),
    }
    if not decision.allowed:
        headers["retry-after"] = str(math.ceil(decision.ttl_ms / 1000))
    return headers


RefusalBody = Callable[[RateDecision], tuple[dict[str, Any], dict[str, str]]]


def rate_limit_dependency(
    limiter: RateLimiter,
    *,
    refusal: RefusalBody,
    client_ip: ClientIp = peer_ip,
    log: Any = None,
) -> Callable[[Request, Response], Awaitable[None]]:
    """A FastAPI dependency: counts the request against `limiter` (per client IP) or raises the 429 `refusal` builds.

    `refusal(decision)` returns the JSON body and extra headers of the 429.
    """
    logger = log if log is not None else structlog.get_logger()

    async def check(request: Request, response: Response) -> None:
        decision = limiter.hit(client_ip(request))
        headers = rate_headers(decision)
        if not decision.allowed:
            route = request.scope.get("route")
            logger.warning("rate limit exceeded", route=getattr(route, "path", request.url.path))
            body, extra = refusal(decision)
            raise HttpError(429, body, {**headers, **extra})
        for name, value in headers.items():
            response.headers[name] = value

    return check
