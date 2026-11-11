"""The `closing` message sent before every server-initiated close (protocol.md v1.7)."""

from __future__ import annotations

import json

from .socket import ManagedSocket


def closing_message(code: int, reason: str) -> str:
    return json.dumps({"type": "closing", "code": int(code), "reason": reason}, separators=(",", ":"))


def close_with_notice(socket: ManagedSocket, code: int, reason: str) -> None:
    """Closes a /call or /chat socket after telling the client why in a `closing` message. The close code carries the
    same information, but Render's proxy replaces custom 4xxx codes with 1000/1005/1006, so the page can't rely on it
    alone. Safe to call on a socket that is already closing."""
    if socket.is_open:
        socket.send_text(closing_message(code, reason))
    socket.close(int(code), reason)
