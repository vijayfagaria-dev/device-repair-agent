"""The engagement block (architecture section 7, P6-T01)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.domain.engagement import CallSpan, compute_engagement
from app.domain.record import Engagement

NOW = datetime(2026, 11, 10, 5, 0, 0, tzinfo=UTC)


def test_sums_finished_calls_counts_an_open_call_up_to_now_and_passes_the_counters_through() -> None:
    calls = [
        CallSpan(datetime(2026, 11, 10, 4, 0, 0, tzinfo=UTC), datetime(2026, 11, 10, 4, 3, 32, tzinfo=UTC)),
        CallSpan(datetime(2026, 11, 10, 4, 59, 0, tzinfo=UTC), None),
    ]
    assert compute_engagement(calls=calls, chat_messages=9, chat_answers=6, invalid_attempts=1, now=NOW) == Engagement(
        calls=2, call_seconds=212 + 60, chat_messages=9, chat_inputs_submitted=6, invalid_attempts=1
    )


def test_rounds_halves_up_like_js_and_never_goes_negative() -> None:
    start = datetime(2026, 11, 10, 4, 0, 0, tzinfo=UTC)
    half = CallSpan(start, datetime(2026, 11, 10, 4, 0, 2, 500000, tzinfo=UTC))
    skewed = CallSpan(start, datetime(2026, 11, 10, 3, 59, 0, tzinfo=UTC))
    assert (
        compute_engagement(calls=[half], chat_messages=0, chat_answers=0, invalid_attempts=0, now=NOW).call_seconds == 3
    )
    assert (
        compute_engagement(calls=[skewed], chat_messages=0, chat_answers=0, invalid_attempts=0, now=NOW).call_seconds
        == 0
    )
    assert compute_engagement(calls=[], chat_messages=0, chat_answers=0, invalid_attempts=0, now=NOW).calls == 0


def test_to_dict_uses_the_wire_keys() -> None:
    assert Engagement(1, 2, 3, 4, 5).to_dict() == {
        "calls": 1,
        "callSeconds": 2,
        "chatMessages": 3,
        "chatInputsSubmitted": 4,
        "invalidAttempts": 5,
    }
