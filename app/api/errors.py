"""Error responses shared by the HTTP routes.

Client errors keep a short JSON body; server errors never expose internals (`{"error": "internal_error"}`). Routes raise
`HttpError` for a response they build themselves (status, JSON body, extra headers).
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class HttpError(Exception):
    """A response a route wants to send: raised anywhere in a handler or dependency."""

    def __init__(self, status: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body
        self.headers = headers or {}


def json_response(status: int, body: Any, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=headers)


def register_error_handlers(app: FastAPI, *, security_headers: dict[str, str] | None = None) -> None:
    """Installs the handlers every response path needs: HttpError, framework 4xx errors and unhandled exceptions.

    `security_headers` are added to the 500 the catch-all builds (it runs outside the middleware stack).
    """
    log = structlog.get_logger()

    async def http_error(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, HttpError)
        return json_response(exc.status, exc.body, exc.headers)

    async def validation_error(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, RequestValidationError)
        return json_response(400, {"error": "bad_request", "message": "The request is not valid."})

    async def framework_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, StarletteHTTPException)
        handler = getattr(request.app.state, "not_found_handler", None)
        if exc.status_code in (404, 405) and handler is not None:
            return await handler(request)
        if exc.status_code in (404, 405):
            return json_response(404, {"error": "not_found"})
        return json_response(exc.status_code, {"error": "bad_request", "message": str(exc.detail)})

    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error("request failed", method=request.method, path=request.url.path, err=exc)
        return json_response(500, {"error": "internal_error"}, security_headers)

    app.add_exception_handler(HttpError, http_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(StarletteHTTPException, framework_error)
    app.add_exception_handler(Exception, unhandled)
