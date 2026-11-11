"""The stub record receiver (P7-T04, D17): the default RECORD_WEBHOOK_URL target, which shows idempotent delivery end to
end. A key is stored once; every repeat is a 200 that only bumps a counter.

- POST /hooks/records needs `X-Hook-Secret` (constant-time compare) and an `Idempotency-Key` (`<sessionId>:<revision>`)
  that matches the body, a record valid against the published schema.
- GET /hooks/records lists what was received; only with the test token, and only when the test API is on.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from typing import Any

import asyncpg
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.config import Secret
from app.db.repos.received_records import list_received_records, upsert_received_record
from app.domain.record import RecordSchemaError, validate_record
from app.protocol.session import parse_session_id

from .serialize import iso
from .sessions import has_bearer_token

#: A record is at most a few KB; this is a generous cap on what the stub reads.
MAX_BODY_BYTES = 256 * 1024
_KEY = re.compile(r"([^:]+):([1-9]\d{0,5})")
_NO_STORE = {"cache-control": "no-store"}


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def secret_matches(header: Any, secret: Secret) -> bool:
    """Constant-time comparison (hashing first makes it independent of the lengths)."""
    return isinstance(header, str) and hmac.compare_digest(_digest(header), _digest(secret.reveal()))


def _reply(status: int, body: dict[str, Any]) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=_NO_STORE)


def _reject_constant(name: str) -> Any:
    raise ValueError(name)  # NaN and Infinity are not JSON


async def _read_json(request: Request) -> tuple[Any, JSONResponse | None]:
    """The parsed JSON body, or the error response Fastify's JSON parser would have given."""
    media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media != "application/json" and not (media.startswith("application/") and media.endswith("+json")):
        return None, _reply(
            415,
            {"error": "FST_ERR_CTP_INVALID_MEDIA_TYPE", "message": f"Unsupported Media Type: {media or 'undefined'}"},
        )
    declared = request.headers.get("content-length")
    too_large = _reply(413, {"error": "FST_ERR_CTP_BODY_TOO_LARGE", "message": "Request body is too large"})
    if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return None, too_large
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            return None, too_large
    if not body:
        return None, _reply(
            400,
            {
                "error": "FST_ERR_CTP_EMPTY_JSON_BODY",
                "message": "Body cannot be empty when content-type is set to 'application/json'",
            },
        )
    try:
        return json.loads(body, parse_constant=_reject_constant), None
    except ValueError:
        return None, _reply(
            400,
            {
                "error": "FST_ERR_CTP_INVALID_JSON_BODY",
                "message": "Body is not valid JSON but content-type is set to 'application/json'",
            },
        )


def hooks_router(
    *, pool: asyncpg.Pool, hook_secret: Secret, test_api_token: Secret | None = None, log: Any = None
) -> APIRouter:
    """POST /hooks/records always; GET /hooks/records only when `test_api_token` is set (ALLOW_TEST_API=true)."""
    logger = log if log is not None else structlog.get_logger()
    router = APIRouter()

    @router.post("/hooks/records")
    async def receive(request: Request) -> Response:
        # Before the body is read: an unauthenticated caller costs a header check, nothing more.
        if not secret_matches(request.headers.get("x-hook-secret"), hook_secret):
            return _reply(401, {"error": "unauthorized"})
        body, problem = await _read_json(request)
        if problem is not None:
            return problem
        header = request.headers.get("idempotency-key")
        match = _KEY.fullmatch(header) if header is not None else None
        session_id = parse_session_id(match.group(1)) if match else None
        if match is None or not session_id or header is None:
            return _reply(
                400, {"error": "invalid_idempotency_key", "message": "Idempotency-Key must be <sessionId>:<revision>."}
            )
        try:
            validate_record(body)
        except RecordSchemaError as err:
            # Paths and keywords only, never the values.
            return _reply(
                400,
                {"error": "invalid_record", "problems": [{"path": p.path, "keyword": p.keyword} for p in err.problems]},
            )
        if body["sessionId"] != session_id or str(body["revision"]) != match.group(2):
            return _reply(
                400,
                {
                    "error": "key_mismatch",
                    "message": "The Idempotency-Key doesn't match the record's sessionId and revision.",
                },
            )
        stored = await upsert_received_record(pool, idempotency_key=header, payload=body)
        logger.info("record received", idempotencyKey=stored.idempotency_key, timesReceived=stored.times_received)
        return _reply(200, {"stored": True, "timesReceived": stored.times_received})

    if test_api_token is not None:
        token = test_api_token

        @router.get("/hooks/records")
        async def list_received(request: Request) -> Response:
            if not has_bearer_token(request.headers.get("authorization"), token):
                return _reply(401, {"error": "unauthorized"})
            received = await list_received_records(pool)
            return _reply(
                200,
                {
                    "records": [
                        {
                            "idempotencyKey": r.idempotency_key,
                            "timesReceived": r.times_received,
                            "firstReceivedAt": iso(r.first_received_at),
                            "lastReceivedAt": iso(r.last_received_at),
                            "record": r.payload,
                        }
                        for r in received
                    ]
                },
            )

    return router
