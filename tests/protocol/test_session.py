"""Session id rules and close codes (protocol.md sections 2, 6)."""

from __future__ import annotations

from typing import Any

import pytest

from app.protocol import SESSION_ID_PATTERN, CloseCode, CloseReason, parse_session_id

ID = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b"


class TestParseSessionId:
    def test_accepts_uuidv4_in_either_case_and_returns_it_lowercase(self) -> None:
        assert parse_session_id(ID) == ID
        assert parse_session_id(ID.upper()) == ID

    @pytest.mark.parametrize(
        "value",
        [
            "abc",
            "",
            None,
            42,
            [ID],
            "0b6f4c1e-3d2a-1e8b-9a71-5c2d8e9f1a3b",  # version 1
            "0b6f4c1e-3d2a-4e8b-7a71-5c2d8e9f1a3b",  # wrong variant
            "0b6f4c1e3d2a4e8b9a715c2d8e9f1a3b",  # no hyphens
            f" {ID}",  # padding
            f"{ID}\n",
            f"{{{ID}}}",
            "lzx8k2m-4f9q2c1d",  # the starter's old Date.now() fallback shape
            "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3g",
        ],
    )
    def test_rejects_everything_that_is_not_a_uuidv4(self, value: Any) -> None:
        assert parse_session_id(value) is None

    def test_matches_the_pattern_published_in_protocol_md_section_2(self) -> None:
        assert SESSION_ID_PATTERN.pattern == "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        assert SESSION_ID_PATTERN.flags & __import__("re").IGNORECASE


def test_close_codes_keeps_the_codes_and_reasons_documented_in_protocol_md_section_6() -> None:
    assert {c.name: c.value for c in CloseCode} == {
        "NORMAL": 1000,
        "MESSAGE_TOO_BIG": 1009,
        "SERVER_ERROR": 1011,
        "SERVER_RESTARTING": 1012,
        "INVALID_SESSION_ID": 4400,
        "ORIGIN_NOT_ALLOWED": 4403,
        "CALL_ALREADY_ACTIVE": 4409,
        "SESSION_CLOSED": 4410,
        "RESUME_REQUIRED": 4411,
        "RATE_LIMITED": 4429,
    }
    assert {k: v for k, v in vars(CloseReason).items() if k.isupper()} == {
        "SERVER_ERROR": "server error",
        "SERVER_RESTARTING": "server restarting",
        "INVALID_SESSION_ID": "invalid session id",
        "ORIGIN_NOT_ALLOWED": "origin not allowed",
        "NEW_SESSION_RATE_LIMITED": "rate limited",
    }
    assert CloseCode.RATE_LIMITED == 4429
