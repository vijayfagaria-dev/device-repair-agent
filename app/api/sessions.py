"""Session HTTP API (P3-T02; D07, D19).

- GET /api/sessions/{id}, /timeline, /records: read-only views for debugging and the test harness. The session id is the
  capability (protocol.md section 2): whoever holds the link sees the session, including what the user entered. Reading
  never creates a session and is never user activity. Rate-limited per client IP.
- POST /api/sessions: test-only session creation, registered only when ALLOW_TEST_API=true and requiring
  `Authorization: Bearer <TEST_API_TOKEN>`. The UI never calls it; browsers create sessions lazily.
- POST /api/sessions/{id}/finalize: the test-only finalize trigger (P7-T01).
"""

from __future__ import annotations

import hashlib
import hmac
import math
import re
import uuid
from typing import Any

import asyncpg
import structlog
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response

from app.config import Secret
from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.input_requests import get_open_input_request
from app.db.repos.outbox import list_outbox
from app.db.repos.records import list_records
from app.db.repos.sessions import Session, get_session
from app.db.repos.timers import list_timers
from app.db.repos.transcript_lines import list_transcript_lines
from app.db.repos.turn_metrics import list_turn_metrics
from app.db.repos.usage import list_usage
from app.domain.fields import RECORD_FIELD_IDS
from app.domain.outcome import missing_required
from app.domain.record import project_value
from app.metrics.usage import session_cost
from app.protocol.session import parse_session_id
from app.session.commands import CommandProcessor, SessionNotFoundError
from app.session.ensure_session import NewSessionSettings, ensure_session
from app.session.handlers.finalize import Finalize
from app.session.snapshot import resolve_fields

from .client_ip import ClientIp, peer_ip
from .rate_limit import RateDecision, RateLimiter, rate_limit_dependency
from .serialize import camel_dict, iso

_BEARER = re.compile(r"Bearer (.+)")
_NO_STORE = {"cache-control": "no-store"}


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def has_bearer_token(header: str | None, token: Secret) -> bool:
    """Constant-time check of a `Bearer` header (hashing first makes the comparison length-independent)."""
    match = _BEARER.fullmatch(header or "")
    if not match:
        return False
    return hmac.compare_digest(_digest(match.group(1)), _digest(token.reveal()))


def _json(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=_NO_STORE)


# ---------------------------------------------------------------------------------------------------------------------
# Test-only creation and finalize


def test_session_router(
    *,
    pool: asyncpg.Pool,
    test_api_token: Secret,
    processor: CommandProcessor,
    new_session: NewSessionSettings | None = None,
    log: Any = None,
) -> APIRouter:
    """POST /api/sessions and POST /api/sessions/{id}/finalize. Mount only when ALLOW_TEST_API=true (a token exists)."""
    logger = log if log is not None else structlog.get_logger()
    router = APIRouter()

    @router.post("/api/sessions")
    async def create(request: Request) -> Response:
        if not has_bearer_token(request.headers.get("authorization"), test_api_token):
            return _json(401, {"error": "unauthorized"})
        id = str(uuid.uuid4())
        result = await ensure_session(pool, id, via="testApi", new_session=new_session)
        if not result.ok or not result.created:
            raise RuntimeError("test API could not create a fresh session")
        logger.info("session created", sessionId=id, via="testApi")
        return _json(201, {"sessionId": id})

    @router.post("/api/sessions/{session_id}/finalize")
    async def finalize(session_id: str, request: Request) -> Response:
        """Finalizes a session with the `testFinalize` trigger (D16): for tests and demos only. It is a trigger like
        any other, so the usual rules apply (an active session only; an unchanged claim gives no new revision)."""
        if not has_bearer_token(request.headers.get("authorization"), test_api_token):
            return _json(401, {"error": "unauthorized"})
        id = parse_session_id(session_id)
        if not id:
            return _json(400, {"error": "invalid_session_id", "message": "The session id must be a UUIDv4."})
        try:
            result = await processor.dispatch(id, Finalize(trigger="testFinalize"))
        except SessionNotFoundError:
            return _json(404, {"error": "not_found", "message": "No such session."})
        reply = result.reply
        return _json(200, reply if reply is not None else {"finalized": False, "reason": "nothing to do"})

    return router


# ---------------------------------------------------------------------------------------------------------------------
# Read API

#: Keys that must never appear in a response, at any depth: secrets and credentials (`...token`, but not counts such as
#: `promptTokens`), internal paths and storage keys (`...path`, `storageKey`), provider-side ids (`provider...Id`), and the
#: LLM's evidence quote. A deny-list, because event payloads are open-ended (D12).
HIDDEN_KEY = re.compile(
    r"(secret|token$|password|passwd|api_?key|authorization|cookie|path$|storage_?key|^evidence$|^provider\w*id$)",
    re.IGNORECASE,
)
_FILE_REF_PREFIX = re.compile(r"^file:(?=[A-Za-z0-9])")


def without_hidden_keys(value: Any) -> Any:
    """A deep copy without hidden keys, and with upload refs (`file:<fileId>`, protocol.md section 8) reduced to the bare
    file id: the ref is the wire form between the page and the server, not something an API consumer should see or
    build on. Event payloads are open-ended, so the timeline filters them on the way out."""
    if isinstance(value, str):
        return _FILE_REF_PREFIX.sub("", value)
    if isinstance(value, list | tuple):
        return [without_hidden_keys(item) for item in value]
    if isinstance(value, dict):
        return {key: without_hidden_keys(item) for key, item in value.items() if not HIDDEN_KEY.search(key)}
    return value


def _unsigned(_file_id: str) -> str:
    return ""


def _display_value(field: str, value: Any) -> Any:
    """File values without a URL: signed links belong only in records (protocol.md section 8)."""
    projected = project_value(field, value, _unsigned)

    def strip(item: Any) -> Any:
        if not isinstance(item, dict):
            return item
        return {k: v for k, v in item.items() if k != "url"}

    if field == "purchaseInvoice":
        return strip(projected)
    if field == "additionalPhotos" and isinstance(projected, list):
        return [strip(item) for item in projected]
    return projected


def session_read_router(
    *, pool: asyncpg.Pool, per_minute: int = 60, client_ip: ClientIp = peer_ip, log: Any = None
) -> APIRouter:
    """The three read routes, rate-limited per client IP across all of them (`per_minute`, default 60)."""
    logger = log if log is not None else structlog.get_logger()

    def refusal(decision: RateDecision) -> tuple[dict[str, Any], dict[str, str]]:
        message = f"Too many requests; try again in {math.ceil(decision.ttl_ms / 1000)} s."
        return {"error": "rate_limited", "message": message}, {}

    limit = rate_limit_dependency(RateLimiter(per_minute, 60_000), refusal=refusal, client_ip=client_ip, log=logger)
    router = APIRouter(dependencies=[Depends(limit)])

    async def load(raw_id: str) -> Session | JSONResponse:
        id = parse_session_id(raw_id)
        if not id:
            return _json(400, {"error": "invalid_session_id", "message": "The session id must be a UUIDv4."})
        session = await get_session(pool, id)
        if session is None:
            return _json(404, {"error": "not_found", "message": "No such session."})
        return session

    @router.get("/api/sessions/{session_id}")
    async def summary(session_id: str) -> Response:
        """The session's current state, with every field's effective value computed by the resolver (P2-T05)."""
        session = await load(session_id)
        if isinstance(session, JSONResponse):
            return session
        candidates = await list_field_candidates(pool, session.id)
        timers = await list_timers(pool, session.id)
        open_request = await get_open_input_request(pool, session.id)
        resolved = resolve_fields(candidates)
        fields = {
            id: {
                "value": _display_value(id, resolved[id].value),
                "source": resolved[id].source,
                "collectedAt": resolved[id].collected_at,
                "status": resolved[id].status,
            }
            for id in RECORD_FIELD_IDS
        }
        conflicts = []
        for id in RECORD_FIELD_IDS:
            conflict = resolved[id].conflict
            if conflict is not None:
                conflicts.append(
                    {
                        "field": conflict.field,
                        "callValue": _display_value(id, conflict.call_value),
                        "chatValue": _display_value(id, conflict.chat_value),
                        "resolution": conflict.resolution,
                        "reason": conflict.reason,
                        "unresolved": conflict.unresolved,
                    }
                )
        return _json(
            200,
            {
                "sessionId": session.id,
                "status": session.status,
                "outcome": session.outcome,
                "revision": session.current_revision if session.current_revision > 0 else None,
                "version": session.version,
                "callActive": session.active_call_id is not None,
                "openRequest": {"id": open_request.id, "field": open_request.field} if open_request else None,
                "fields": fields,
                "missingRequired": missing_required(resolved),
                "conflicts": conflicts,
                "timers": [{"kind": t.kind, "dueAt": iso(t.due_at)} for t in timers],
                "createdAt": iso(session.created_at),
                "lastActivityAt": iso(session.last_activity_at),
            },
        )

    @router.get("/api/sessions/{session_id}/timeline")
    async def timeline(session_id: str) -> Response:
        """Events, transcript, turn timings and cost (D19): the debugging timeline."""
        session = await load(session_id)
        if isinstance(session, JSONResponse):
            return session
        events = await list_events(pool, session.id)
        transcript = await list_transcript_lines(pool, session.id)
        turns = await list_turn_metrics(pool, session.id)
        usage = await list_usage(pool, session.id)
        cost = await session_cost(pool, session.id)
        outbox = await list_outbox(pool, session.id)
        return _json(
            200,
            {
                "sessionId": session.id,
                "events": [
                    {
                        "seq": e.seq,
                        "type": e.type,
                        "channel": e.channel,
                        "at": iso(e.created_at),
                        "payload": without_hidden_keys(e.payload),
                    }
                    for e in events
                ],
                "transcript": [
                    {
                        "id": line.id,
                        "callId": line.call_id,
                        "role": line.role,
                        "text": line.text,
                        "interrupted": line.interrupted,
                        "startedAt": iso(line.started_at),
                    }
                    for line in transcript
                ],
                "turns": [without_hidden_keys(camel_dict(turn)) for turn in turns],
                "usage": [
                    {
                        "provider": u.provider,
                        "kind": u.kind,
                        "units": u.units,
                        "unit": u.unit,
                        "costUsd": u.cost_usd,
                        "at": iso(u.at),
                    }
                    for u in usage
                ],
                "cost": {
                    "costUsd": cost.cost_usd,
                    "costBreakdownUsd": cost.cost_breakdown_usd,
                    "actualSpendUsd": cost.actual_spend_usd,
                },
                # Delivery of each record revision (P7-T03): a dead one shows here with its last error.
                "deliveries": [
                    {
                        "revision": d.revision,
                        "target": d.target,
                        "status": d.status,
                        "attempts": d.attempts,
                        "nextAttemptAt": None if d.status in ("delivered", "dead") else iso(d.next_attempt_at),
                        "lastError": d.last_error,
                        "deliveredAt": iso(d.delivered_at) if d.delivered_at else None,
                    }
                    for d in outbox
                ],
            },
        )

    @router.get("/api/sessions/{session_id}/records")
    async def records(session_id: str) -> Response:
        """Every record revision, oldest first (immutable, D17)."""
        session = await load(session_id)
        if isinstance(session, JSONResponse):
            return session
        stored = await list_records(pool, session.id)
        return _json(
            200,
            {
                "sessionId": session.id,
                "records": [
                    {
                        "revision": r.revision,
                        "outcome": r.outcome,
                        "contentHash": r.content_hash,
                        "createdAt": iso(r.created_at),
                        "record": r.payload,
                    }
                    for r in stored
                ],
            },
        )

    return router
