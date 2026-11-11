"""Serves the built web UI (web/dist) from the same origin as the API (D07), with a SPA fallback that never answers API
paths or missing assets with HTML.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response

#: `web/dist` at the repository root (this file is `<root>/app/api/web.py`).
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

#: Path prefixes owned by the server. Unknown paths under them get a JSON 404, never the UI.
SERVER_PREFIXES = ["/api", "/sessions", "/files", "/hooks", "/call", "/chat", "/healthz", "/readyz"]

_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


def is_server_path(pathname: str) -> bool:
    return any(pathname == prefix or pathname.startswith(f"{prefix}/") for prefix in SERVER_PREFIXES)


def _looks_like_file(pathname: str) -> bool:
    """A last path segment with a dot looks like a file (`/assets/app.js`); a missing file must 404, not get HTML."""
    return "." in pathname[pathname.rfind("/") + 1 :]


mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


def register_web(
    app: FastAPI, *, dist_dir: Path | str = DEFAULT_WEB_DIST, require_build: bool = False, log: Any = None
) -> None:
    """Adds the UI and the 404 policy: call it after every other route is registered.

    Anything no other route answers (any method) lands here: a file of the build; the UI for a client-side page path
    (GET/HEAD, not a server prefix, not file-like); otherwise `404 {"error": "not_found"}`. Raises when the build is
    required and missing. Also makes the framework's own 404/405 answers use the same policy.
    """
    logger = log if log is not None else structlog.get_logger()
    dist = Path(dist_dir)
    has_build = (dist / "index.html").is_file()
    if not has_build:
        if require_build:
            raise RuntimeError(f"Web build not found at {dist}; run npm run build first")
        logger.warning("web build not found; serving the API only", distDir=str(dist))
    root = dist.resolve()
    assets = root / "assets"

    def file_for(pathname: str) -> Path | None:
        relative = pathname.lstrip("/")
        parts = [part for part in relative.split("/") if part]
        if any(part.startswith(".") for part in parts):  # dotfiles are never served
            return None
        candidate = (root / relative).resolve() if relative else root / "index.html"
        if not candidate.is_relative_to(root):
            return None
        return candidate if candidate.is_file() else None

    def not_found() -> Response:
        return JSONResponse({"error": "not_found"}, status_code=404)

    async def serve(request: Request) -> Response:
        pathname = request.url.path
        is_page_request = request.method in ("GET", "HEAD")
        if has_build and is_page_request:
            found = file_for(pathname)
            if found is not None:
                immutable = found.is_relative_to(assets)
                return FileResponse(
                    found, headers={"cache-control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
                )
            if not is_server_path(pathname) and not _looks_like_file(pathname):
                return FileResponse(root / "index.html", headers={"cache-control": "no-cache"})
        return not_found()

    app.state.not_found_handler = serve
    app.add_api_route("/{full_path:path}", serve, methods=_METHODS, include_in_schema=False)
