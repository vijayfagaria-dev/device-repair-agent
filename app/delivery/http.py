"""One delivery attempt (P7-T03, D17): POST the record with its idempotency key and read the verdict from the status.

The verdict is all the worker needs; the error text is short and never holds the URL, the secret or a response body
(it is stored in the outbox row and shown in the timeline).
"""

from __future__ import annotations

import asyncio
import socket
from dataclasses import dataclass
from typing import Literal

import httpx

from app.config import Secret


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    """`delivered`; `retry` (worth trying again later: the receiver was down, slow, rate-limiting us or failed on its
    side); or `dead` (retrying can't help: the receiver rejected the request itself, 4xx other than 408 and 429)."""

    kind: Literal["delivered", "retry", "dead"]
    error: str | None = None


def _network_code(err: BaseException) -> str | None:
    """The Node-style code of the underlying socket error (ECONNREFUSED, ...), when there is a recognisable one."""
    seen: set[int] = set()
    current: BaseException | None = err
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ConnectionRefusedError):
            return "ECONNREFUSED"
        if isinstance(current, ConnectionResetError):
            return "ECONNRESET"
        if isinstance(current, socket.gaierror):
            return "ENOTFOUND"
        current = current.__cause__ or current.__context__
    return None


async def post_record(
    *,
    url: Secret,
    hook_secret: Secret,
    idempotency_key: str,
    body: str,
    timeout_ms: float,
    client: httpx.AsyncClient,
) -> DeliveryResult:
    """POSTs `body` and maps the answer: 2xx delivered; 4xx except 408/429 dead; anything else retry."""
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            # A redirect would carry the secret header to another host: it is not followed (a failure instead).
            async with client.stream(
                "POST",
                url.reveal(),
                content=body.encode("utf-8"),
                headers={
                    "content-type": "application/json",
                    "idempotency-key": idempotency_key,
                    "x-hook-secret": hook_secret.reveal(),
                },
                timeout=timeout_ms / 1000,
                follow_redirects=False,
            ) as response:
                status = response.status_code
    except (TimeoutError, httpx.TimeoutException):
        return DeliveryResult("retry", f"timeout after {timeout_ms:g} ms")
    except (httpx.HTTPError, OSError) as err:
        code = _network_code(err)
        return DeliveryResult("retry", f"network error ({code})" if code else "network error")
    if 200 <= status < 300:
        return DeliveryResult("delivered")
    if 400 <= status < 500 and status not in (408, 429):
        return DeliveryResult("dead", f"HTTP {status}")
    return DeliveryResult("retry", f"HTTP {status}")
