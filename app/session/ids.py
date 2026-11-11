"""Server-generated ids (protocol.md section 1.1): random base64url, 96 bits."""

from __future__ import annotations

import secrets


def new_message_id() -> str:
    """A chat message id (wire id `m_<id>`); chat_messages.id is unique across all sessions."""
    return secrets.token_urlsafe(12)


def new_file_id() -> str:
    """A stored file id (`file:<id>` refs and `/files/<id>` links)."""
    return f"f{secrets.token_urlsafe(12)}"
