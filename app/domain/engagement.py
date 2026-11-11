"""The record's engagement block (architecture section 7, P6-T01): how much the user engaged, from the session's calls,
chat messages, chat answers and card attempts. Pure."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from .record import Engagement


@dataclass(frozen=True, slots=True)
class CallSpan:
    started_at: datetime
    ended_at: datetime | None


def compute_engagement(
    *,
    calls: Sequence[CallSpan],
    chat_messages: int,
    chat_answers: int,
    invalid_attempts: int,
    now: datetime,
) -> Engagement:
    """`calls`: the session's calls (an unfinished one counts up to `now`); `chat_messages`: agent and user messages in
    the thread; `chat_answers`: answers submitted in chat cards, valid or not; `invalid_attempts`: across all cards."""
    call_seconds = 0
    for call in calls:
        end = call.ended_at or now
        # JS Math.round: halves round up.
        call_seconds += max(0, math.floor((end - call.started_at).total_seconds() + 0.5))
    return Engagement(
        calls=len(calls),
        call_seconds=call_seconds,
        chat_messages=chat_messages,
        chat_inputs_submitted=chat_answers,
        invalid_attempts=invalid_attempts,
    )
