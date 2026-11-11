"""Validation entry points for /chat messages (shared/protocol/schemas.ts): the server validates every inbound message
with `parse_chat_client_message`; tests validate what the server sends with `parse_chat_server_message`."""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter

from .types import (
    MAX_ID_CHARS,
    MAX_INPUT_ARRAY_ITEMS,
    MAX_INPUT_STRING_CHARS,
    MAX_MESSAGE_TEXT_CHARS,
    ChatClientMessage,
    ChatServerMessage,
)

__all__ = [
    "CHAT_CLIENT_MESSAGE_ADAPTER",
    "CHAT_SERVER_MESSAGE_ADAPTER",
    "MAX_ID_CHARS",
    "MAX_INPUT_ARRAY_ITEMS",
    "MAX_INPUT_STRING_CHARS",
    "MAX_MESSAGE_TEXT_CHARS",
    "parse_chat_client_message",
    "parse_chat_server_message",
]

CHAT_CLIENT_MESSAGE_ADAPTER: TypeAdapter[Any] = TypeAdapter(ChatClientMessage)
CHAT_SERVER_MESSAGE_ADAPTER: TypeAdapter[Any] = TypeAdapter(ChatServerMessage)


def parse_chat_client_message(raw: Any) -> Any:
    """Validates a decoded JSON value; raises pydantic.ValidationError when the shape is wrong."""
    return CHAT_CLIENT_MESSAGE_ADAPTER.validate_python(raw)


def parse_chat_server_message(raw: Any) -> Any:
    """Validates what the server sends (strict); raises pydantic.ValidationError."""
    return CHAT_SERVER_MESSAGE_ADAPTER.validate_python(raw)
