"""Session identity and WebSocket close codes (protocol.md sections 2 and 6)."""

from __future__ import annotations

import re
from enum import IntEnum
from typing import Any

# A UUIDv4, either case (protocol.md section 2). The browser generates it; the server rejects anything else.
# Same source text as the TS pattern (it is also published in protocol.md and record.schema.json); matched with
# fullmatch so a trailing newline is rejected (JS `$` without the m flag has the same effect).
SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)


def parse_session_id(raw: Any) -> str | None:
    """Returns the canonical (lowercase) session id, or None when `raw` is not a UUIDv4."""
    if isinstance(raw, str) and SESSION_ID_PATTERN.fullmatch(raw):
        return raw.lower()
    return None


class CloseCode(IntEnum):
    """Close codes the server sends on /chat and /call (always after completing the upgrade)."""

    NORMAL = 1000
    MESSAGE_TOO_BIG = 1009
    SERVER_ERROR = 1011
    SERVER_RESTARTING = 1012
    INVALID_SESSION_ID = 4400
    ORIGIN_NOT_ALLOWED = 4403
    CALL_ALREADY_ACTIVE = 4409
    SESSION_CLOSED = 4410
    # /call: the user opted out earlier; the chat asks "Resume your claim?" first (protocol v1.5, P7-T05).
    RESUME_REQUIRED = 4411
    # /call: concurrent-call cap or quota guard. /chat: too many new sessions from one address (protocol v1.1).
    RATE_LIMITED = 4429


class CloseReason:
    SERVER_ERROR = "server error"
    SERVER_RESTARTING = "server restarting"
    INVALID_SESSION_ID = "invalid session id"
    ORIGIN_NOT_ALLOWED = "origin not allowed"
    NEW_SESSION_RATE_LIMITED = "rate limited"
