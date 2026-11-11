"""The per-turn state message (P5-T05, architecture section 6).

A trailing system message holding everything that changes, so the system + tools prefix stays byte-stable. Compact JSON:
local IST time, what is collected (display values; files as "PDF, 178 KB", never a path or link), what is missing,
identifiers only heard on the call, pending chat cards, chat events since the last turn, and whether this is a
returning call. Anything the customer typed in chat is wrapped as data (<chat_input>), with angle brackets escaped so it
can't close the tag (prompt-injection hygiene).
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from app.agent.chat_planner import field_state
from app.agent.chat_templates import summary_value
from app.db.repos.input_requests import StoredInputRequest
from app.domain.conflicts import ResolvedField
from app.domain.fields import FIELDS, RECORD_FIELD_IDS, REQUIRED_RECORD_FIELDS
from app.voice.types import LlmMessage


@dataclass(frozen=True, slots=True)
class ChatEventNote:
    """One chat event since the agent's last turn (P5-T08), as the call engine collected it from the hub."""

    field: str
    result: Literal["accepted", "rejected", "cancelled", "skipped"]
    #: Rejections of this field's card so far (voice help after 2+).
    rejections: int | None = None


@dataclass(slots=True)
class StateInput:
    now: datetime
    #: When this call started (ms since the epoch).
    call_started_at: float
    #: Anything with ``status`` and ``outcome`` (a ``Session``).
    session: Any
    fields: Mapping[str, ResolvedField]
    requests: Sequence[StoredInputRequest]
    is_returning_call: bool
    new_chat_events: Sequence[ChatEventNote]
    #: For a returning call: the last thing the agent said on the previous call.
    last_agent_line: str | None = None


_LEFT_ANGLE = chr(0x2039)
_RIGHT_ANGLE = chr(0x203A)


def _escape_tags(text: str) -> str:
    return text.replace("<", _LEFT_ANGLE).replace(">", _RIGHT_ANGLE)


def as_chat_data(field: str, text: str) -> str:
    """Text the customer typed, as data: ``<chat_input field="email">...</chat_input>``, brackets escaped."""
    return f'<chat_input field="{field}">{_escape_tags(text)}</chat_input>'


def as_spoken_data(field: str, text: str) -> str:
    """What the customer said on the call (it comes from their own words), as data too (P5 review #15)."""
    return f'<customer_words field="{field}">{_escape_tags(text)}</customer_words>'


_IST = timezone(timedelta(hours=5, minutes=30), "Asia/Kolkata")
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def ist_local_time(now: datetime) -> str:
    """ "2026-11-10 13:45 Tuesday" in IST (D14: date logic runs in Asia/Kolkata)."""
    local = now.astimezone(_IST)
    return f"{local:%Y-%m-%d %H:%M} {_WEEKDAYS[local.weekday()]}"


def _js_round(value: float) -> int:
    return math.floor(value + 0.5)


def build_state(state_input: StateInput) -> dict[str, Any]:
    state = field_state(requests=state_input.requests, candidates=[])
    fields = state_input.fields
    collected: dict[str, str] = {}
    unverified: list[str] = []
    for field_id in RECORD_FIELD_IDS:
        field = fields[field_id]
        if field.status == "valid":
            text = summary_value(field_id, field)
            collected[field_id] = (
                as_chat_data(field_id, text) if field.source == "chat" else as_spoken_data(field_id, text)
            )
        elif field.status == "unverified":
            unverified.append(field_id)
        elif field.status == "skipped":
            collected[field_id] = "skipped"
    stuck = [i for i in REQUIRED_RECORD_FIELDS if fields[i].status != "valid" and state.stuck(i)]
    missing = [i for i in REQUIRED_RECORD_FIELDS if fields[i].status != "valid" and i not in stuck]
    pending = [r.field for r in state_input.requests if r.status in ("open", "queued")]
    session = state_input.session
    if session.status == "active":
        claim_status = "collecting"
    else:
        claim_status = "stopped" if session.outcome == "optedOut" else "submitted"
    result: dict[str, Any] = {
        "localTime": ist_local_time(state_input.now),
        "callSecondsElapsed": max(
            0, _js_round((state_input.now.timestamp() * 1000 - state_input.call_started_at) / 1000)
        ),
        "claimStatus": claim_status,
        "isReturningCall": state_input.is_returning_call,
    }
    if state_input.is_returning_call and state_input.last_agent_line:
        result["lastQuestionOnPreviousCall"] = state_input.last_agent_line[:200]
    result["collected"] = collected
    result["missing"] = missing
    # Heard on the call but must be typed in the chat card (D13 identifier rule).
    result["heardButMustBeTyped"] = unverified
    result["givenUp"] = stuck
    result["pendingChatCards"] = pending
    result["readyToSubmit"] = (
        not missing and not stuck and "submitConfirmation" not in pending and claim_status == "collecting"
    )
    result["newChatEvents"] = [
        {"field": e.field, "result": e.result, **({"rejections": e.rejections} if e.rejections else {})}
        for e in state_input.new_chat_events
    ]
    return result


def state_message(state_input: StateInput) -> LlmMessage:
    return LlmMessage(
        role="system",
        content=f"STATE {json.dumps(build_state(state_input), separators=(',', ':'), ensure_ascii=False)}",
    )


def spoken_label(field: str) -> str:
    """Field labels the agent uses when it speaks a templated acknowledgement (acknowledge-then-ask, D13)."""
    return FIELDS[field].label if field in FIELDS else "that"
