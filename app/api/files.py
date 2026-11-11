"""Uploads and signed downloads (P4-T03, D10, protocol.md section 8).

- POST /sessions/{session_id}/files: one multipart part named `file`, at most 10 MB. The type comes from the bytes
  (magic numbers), never the name or the browser's claim. Stored with its SHA-256 in Postgres; the answer is an opaque
  `file:<id>` ref that only this session's cards accept (P4-T02). Lazily creates the session, like a connect.
- GET /files/{file_id}?exp&sig: the bytes, only with a valid, unexpired HMAC signature (links appear only in records).

Errors are `{ "error": { "code", "message" } }`. At most two uploads are read into memory at once per instance (each can
hold up to 10 MB on a small free instance), one per client IP, and each must arrive within a deadline, so slow senders
can't hold the slots; a client IP may also store only so many bytes an hour, so one address can't use up the global
budget for everyone (P4 review #3, #4). Beyond any of these: 429, and the browser can retry.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import quote

import asyncpg
import structlog
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header

from app.domain.fields import MAX_FILE_BYTES
from app.domain.validators.files import validate_upload
from app.files.signing import FileUrlSigner
from app.files.storage import NewUpload, store_upload
from app.files.storage import read_stored_file as _read_stored_file
from app.protocol.session import parse_session_id
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import CreationLimit, NewSessionSettings, ensure_session
from app.session.ids import new_file_id

from .client_ip import ClientIp, peer_ip
from .errors import HttpError
from .rate_limit import RateDecision, RateLimiter, rate_limit_dependency

UploadErrorCode = Literal[
    "bad_request", "session_closed", "too_large", "unsupported_type", "rate_limited", "storage_budget", "internal_error"
]

_FILE_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
_NO_STORE = {"cache-control": "no-store"}


def fail(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=_NO_STORE)


def attachment_header(name: str | None, file_id: str) -> str:
    """A Content-Disposition that can't break out of its header: an ASCII fallback plus the RFC 5987 UTF-8 name."""
    base = file_id if name is None else name
    # Per UTF-16 code unit, as the TypeScript regex worked: an astral character is two underscores.
    ascii_name = "".join(
        ch if 0x20 <= ord(ch) <= 0x7E and ch not in '"\\' else "_" * (1 if ord(ch) < 0x10000 else 2) for ch in base
    )
    encoded = quote(base, safe="-_.!~*'()")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"


class ByteQuota:
    """Bytes per key per fixed window, in memory (per instance; enough to stop one address filling the budget)."""

    def __init__(self, max_bytes: int, window_ms: float, now: Callable[[], float] | None = None) -> None:
        self.max_bytes = max_bytes
        self.window_ms = window_ms
        self._now = now or (lambda: time.time() * 1000)
        self._used: dict[str, list[float]] = {}  # key -> [since, bytes]

    def try_use(self, key: str, size: int) -> bool:
        now = self._now()
        for k in [k for k, entry in self._used.items() if now - entry[0] >= self.window_ms]:
            del self._used[k]
        entry = self._used.get(key) or [now, 0]
        if entry[1] + size > self.max_bytes:
            return False
        entry[1] += size
        self._used[key] = entry
        return True

    def give_back(self, key: str, size: int) -> None:
        """Returns bytes that weren't stored after all."""
        entry = self._used.get(key)
        if entry is not None:
            entry[1] = max(0, entry[1] - size)


# ---------------------------------------------------------------------------------------------------------------------
# Reading the one file part, with a byte cap while it streams in


class _UploadProblem(Exception):
    def __init__(self, code: Literal["too_large", "one_file", "not_multipart"]) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class _Part:
    field_name: str | None = None
    filename: str | None = None
    mimetype: str = "text/plain"  # busboy's default for a part without a Content-Type
    is_file: bool = False
    data: bytearray | None = None


def _basename(name: str) -> str:
    return re.split(r"[\\/]", name)[-1]


async def _read_file_part(request: Request, max_bytes: int) -> _Part | None:
    """The first part of the multipart body (None when there is none), reading at most `max_bytes` of its content.

    Raises `_UploadProblem`: too_large (413), one_file (more than one part, or a plain field), not_multipart.
    """
    _, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if not boundary:
        raise _UploadProblem("not_multipart")
    parts: list[_Part] = []
    header_name = bytearray()
    header_value = bytearray()
    headers: dict[str, bytes] = {}

    def on_part_begin() -> None:
        if parts:
            raise _UploadProblem("one_file")
        parts.append(_Part())
        headers.clear()

    def on_header_field(data: bytes, start: int, end: int) -> None:
        header_name.extend(data[start:end])

    def on_header_value(data: bytes, start: int, end: int) -> None:
        header_value.extend(data[start:end])

    def on_header_end() -> None:
        headers[header_name.decode("latin-1").lower()] = bytes(header_value)
        header_name.clear()
        header_value.clear()

    def on_headers_finished() -> None:
        part = parts[-1]
        disposition = headers.get("content-disposition", b"")
        _, options = parse_options_header(disposition)
        name = options.get(b"name")
        part.field_name = name.decode("utf-8", "replace") if name is not None else None
        filename = options.get(b"filename")
        if filename is not None:
            part.is_file = True
            part.filename = _basename(filename.decode("utf-8", "replace"))
            part.data = bytearray()
        else:
            raise _UploadProblem("one_file")  # a plain field: the endpoint allows no fields
        content_type = headers.get("content-type")
        if content_type:
            part.mimetype = parse_options_header(content_type)[0].decode("latin-1").lower()

    def on_part_data(data: bytes, start: int, end: int) -> None:
        part = parts[-1]
        assert part.data is not None
        part.data.extend(data[start:end])
        if len(part.data) > max_bytes:
            raise _UploadProblem("too_large")

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": on_part_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
        },
    )
    try:
        async for chunk in request.stream():
            parser.write(chunk)
        parser.finalize()
    except MultipartParseError:
        raise _UploadProblem("not_multipart") from None
    return parts[0] if parts else None


# ---------------------------------------------------------------------------------------------------------------------


def files_router(
    *,
    pool: asyncpg.Pool,
    signer: FileUrlSigner,
    budget_bytes: int,
    session_limiter: CreationLimiter,
    new_session: NewSessionSettings | None = None,
    max_concurrent_uploads: int = 2,
    uploads_per_minute: int = 30,
    downloads_per_minute: int = 120,
    upload_bytes_per_ip_per_hour: int = 100 * 1024 * 1024,
    upload_deadline_ms: float = 60_000,
    client_ip: ClientIp = peer_ip,
    now: Callable[[], datetime] | None = None,
    log: Any = None,
) -> APIRouter:
    """The upload and download routes. Mount them only when FILE_URL_SECRET is set (a `signer` exists).

    `session_limiter` is the per-IP new-session limiter shared with the sockets; `new_session` the new-session timer
    settings; `client_ip` honours TRUST_PROXY_HOPS (`make_client_ip`).
    """
    logger = log if log is not None else structlog.get_logger()
    clock = now or (lambda: datetime.now(UTC))
    quota = ByteQuota(upload_bytes_per_ip_per_hour, 60 * 60 * 1000)
    state = {"uploading": 0}
    uploading_by_ip: dict[str, int] = {}

    def refusal(decision: RateDecision) -> tuple[dict[str, Any], dict[str, str]]:
        message = f"Too many uploads; try again in {math.ceil(decision.ttl_ms / 1000)} s."
        return {"error": {"code": "rate_limited", "message": message}}, dict(_NO_STORE)

    # Per route: uploads and downloads have separate budgets.
    upload_limit = rate_limit_dependency(
        RateLimiter(uploads_per_minute, 60_000), refusal=refusal, client_ip=client_ip, log=logger
    )
    download_limit = rate_limit_dependency(
        RateLimiter(downloads_per_minute, 60_000), refusal=refusal, client_ip=client_ip, log=logger
    )
    router = APIRouter()

    @router.post("/sessions/{session_id}/files", dependencies=[Depends(upload_limit)])
    async def upload(session_id: str, request: Request) -> Response:
        try:
            return await _upload(session_id, request)
        except HttpError:
            raise
        except Exception as err:
            logger.error("file request failed", code=getattr(err, "code", None), err=str(err))
            return fail(500, "internal_error", "Something went wrong. Please try again.")

    async def _upload(raw_session_id: str, request: Request) -> Response:
        session_id = parse_session_id(raw_session_id)
        if not session_id:
            return fail(400, "bad_request", "The session id must be a UUIDv4.")
        content_type = request.headers.get("content-type", "")
        if not content_type.lower().startswith("multipart/"):
            return fail(400, "bad_request", "Send the file as multipart/form-data with one part named file.")
        ip = client_ip(request)
        if state["uploading"] >= max_concurrent_uploads or uploading_by_ip.get(ip, 0) >= 1:
            logger.warning(
                "upload refused: too many at once", uploading=state["uploading"], maxConcurrent=max_concurrent_uploads
            )
            return fail(429, "rate_limited", "Too many uploads at once. Please try again in a moment.")
        state["uploading"] += 1
        uploading_by_ip[ip] = uploading_by_ip.get(ip, 0) + 1
        deadline = time.monotonic() + upload_deadline_ms / 1000
        try:
            created = await ensure_session(
                pool,
                session_id,
                via="upload",
                limit=CreationLimit(limiter=session_limiter, key=ip),
                new_session=new_session,
            )
            if not created.ok:
                logger.warning("upload refused: new-session rate limit")
                return fail(429, "rate_limited", "Too many new claims from this network. Please try again later.")
            assert created.session is not None
            if created.session.status == "closed":
                return fail(410, "session_closed", "This claim is closed.")

            try:
                async with asyncio.timeout(max(0.0, deadline - time.monotonic())):
                    part = await _read_file_part(request, MAX_FILE_BYTES)
            except _UploadProblem as problem:
                if problem.code == "too_large":
                    return fail(413, "too_large", "That file is larger than 10 MB.")
                if problem.code == "one_file":
                    return fail(400, "bad_request", "Upload one file at a time.")
                return fail(400, "bad_request", "Send the file as multipart/form-data.")
            except TimeoutError:
                logger.warning("upload dropped: too slow", deadlineMs=upload_deadline_ms)
                return fail(408, "bad_request", "The upload took too long. Please try again.")
            if part is None or part.field_name != "file" or part.data is None:
                return fail(400, "bad_request", "The upload needs one part named file.")
            data = bytes(part.data)

            checked = validate_upload("purchaseInvoice", bytes=data, declared_type=part.mimetype, name=part.filename)
            if checked.status != "valid":
                message = getattr(checked, "error", None) if checked.status == "invalid" else None
                message = message or "That file couldn't be read."
                if len(data) == 0:
                    return fail(400, "bad_request", message)
                if len(data) > MAX_FILE_BYTES:
                    return fail(413, "too_large", message)
                return fail(415, "unsupported_type", message)
            normalized = checked.normalized
            assert normalized is not None

            if not quota.try_use(ip, len(data)):
                logger.warning("upload refused: per-IP hourly byte quota", size=len(data))
                return fail(429, "rate_limited", "You've uploaded a lot in the last hour. Please try again later.")
            stored = await store_upload(
                pool,
                NewUpload(
                    id=new_file_id(),
                    session_id=session_id,
                    mime=normalized["mime"],
                    data=data,
                    original_name=normalized["originalName"],
                ),
                budget_bytes=budget_bytes,
            )
            if not stored.ok:
                quota.give_back(ip, len(data))
                if stored.reason == "tooManyFiles":
                    return fail(413, "too_large", "This claim already has the most files it can hold (12).")
                logger.error("upload refused: the global upload budget is used up", budgetBytes=budget_bytes)
                return fail(507, "storage_budget", "Uploads are unavailable right now. Please try again later.")
            assert stored.file is not None
            logger.info(
                "file stored",
                sessionId=session_id,
                fileId=stored.file.id,
                mime=stored.file.mime,
                size=stored.file.size,
            )
            return JSONResponse({"url": f"file:{stored.file.id}"}, headers=_NO_STORE)
        finally:
            state["uploading"] -= 1
            left = uploading_by_ip.get(ip, 1) - 1
            if left > 0:
                uploading_by_ip[ip] = left
            else:
                uploading_by_ip.pop(ip, None)

    @router.get("/files/{file_id}", dependencies=[Depends(download_limit)])
    async def download(file_id: str, request: Request) -> Response:
        if not _FILE_ID.fullmatch(file_id):
            return fail(404, "not_found", "No such file.")
        query = request.query_params
        exp: Any = query.get("exp") if len(query.getlist("exp")) <= 1 else query.getlist("exp")
        sig: Any = query.get("sig") if len(query.getlist("sig")) <= 1 else query.getlist("sig")
        check = signer.check(file_id, exp, sig, clock())
        if check == "badSignature":
            return fail(403, "forbidden", "This link isn't valid.")
        if check == "expired":
            return fail(410, "expired", "This link has expired.")
        found = await _read_stored_file(pool, file_id)
        if found is None:
            return fail(404, "not_found", "No such file.")
        return Response(
            found.data,
            headers={
                "content-type": found.file.mime,
                "content-disposition": attachment_header(found.file.original_name, file_id),
                "x-content-type-options": "nosniff",
                "cache-control": "private, no-store",
            },
        )

    return router
