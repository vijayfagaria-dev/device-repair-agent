"""Security headers (P10-T02, MH6). Set on every HTTP response, including errors and the static UI. A WebSocket upgrade
is not an HTTP response with these headers; its protection is the Origin check (ws/handshake).

The CSP is tight because the page needs little: its own script (Vite's bundle and the capture worklet are both files
under /assets, so `script-src 'self'` covers `audioWorklet.addModule`), its own stylesheet (React sets styles through
the CSSOM, which CSP allows, so there is no 'unsafe-inline'), the chat/call sockets on its own origin, and blob:
images for the preview of a file the user is about to upload. Nothing is loaded from a third party.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import FastAPI
from starlette.types import ASGIApp, Message, Receive, Scope, Send


def _socket_origin(public_origin: str) -> str:
    """The `connect-src` entry for the page's own WebSocket origin; `'self'` alone doesn't cover ws: in every browser."""
    url = urlsplit(public_origin)
    return f"{'wss:' if url.scheme == 'https' else 'ws:'}//{url.netloc}"


def content_security_policy(public_origin: str) -> str:
    return "; ".join(
        [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' blob:",
            f"connect-src 'self' {_socket_origin(public_origin)}",
            "worker-src 'self' blob:",
            "font-src 'self'",
            "manifest-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def security_headers(public_origin: str) -> dict[str, str]:
    headers = {
        "content-security-policy": content_security_policy(public_origin),
        "referrer-policy": "no-referrer",
        # The page may use its own microphone and nothing else; no embedded frame can.
        "permissions-policy": "microphone=(self), camera=(), geolocation=(), payment=(), usb=()",
        "x-content-type-options": "nosniff",
        "cross-origin-opener-policy": "same-origin",
    }
    # Only over HTTPS: a browser ignores HSTS on plain HTTP, and local development runs on http://localhost.
    if public_origin.startswith("https://"):
        headers["strict-transport-security"] = "max-age=31536000"
    return headers


class SecurityHeadersMiddleware:
    """Pure ASGI middleware: adds the headers to every HTTP response (WebSocket scopes pass through untouched)."""

    def __init__(self, app: ASGIApp, public_origin: str) -> None:
        self.app = app
        self._raw = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in security_headers(public_origin).items()]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in self._raw if k not in present]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def register_security_headers(app: FastAPI, public_origin: str) -> None:
    """Adds the headers to every response. Register before the routes."""
    app.add_middleware(SecurityHeadersMiddleware, public_origin=public_origin)
