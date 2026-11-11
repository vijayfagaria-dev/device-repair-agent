"""Latency measurement helpers (P11-T02, D20): the per-turn row. Pure functions: no clock, no database.

(The summary statistics live in scripts/report.ts, which runs without a build.)
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

#: The agent turn id the call engine mints (`ta_<callId>_<n>`); the client echoes it in `clientMetric`.
_AGENT_TURN_ID = re.compile(r"ta_(.+)_\d+")


def call_id_of_turn(turn_id: str) -> str | None:
    """The call a turn id belongs to, or None when it isn't an agent turn id."""
    match = _AGENT_TURN_ID.fullmatch(turn_id)
    return match.group(1) if match else None


@dataclass(frozen=True, slots=True)
class TurnFacts:
    turn_id: str
    call_id: str
    #: Epoch ms: STT's end-of-utterance event, when the reply follows a user utterance.
    user_end_at: float | None
    #: Epoch ms: the first TTS audio frame written to the socket.
    first_audio_at: float | None
    #: Wait between STT's end-of-utterance event and the turn being handed to the agent (the merge window).
    stt_ms: float | None = None
    llm_ttft_ms: float | None = None
    tts_ttfb_ms: float | None = None


def js_round(value: float) -> int:
    """JavaScript `Math.round` (halves round up), not Python's banker's rounding."""
    return math.floor(value + 0.5)


def _whole(ms: float) -> int:
    return max(0, js_round(ms))


def _date(epoch_ms: float) -> datetime:
    return datetime.fromtimestamp(epoch_ms / 1000, tz=UTC)


def build_turn_metric(facts: TurnFacts) -> dict[str, Any] | None:
    """
    The `upsert_turn_metric` keyword arguments (all except `session_id`) for one agent turn, or None when there is
    nothing to record (a turn with neither a user utterance before it nor any audio). Only the stages that exist are
    present. `server_ms` = user end -> first audio; it needs both ends.
    """
    if facts.user_end_at is None and facts.first_audio_at is None:
        return None
    metric: dict[str, Any] = {"turn_id": facts.turn_id, "call_id": facts.call_id}
    if facts.user_end_at is not None:
        metric["user_end_at"] = _date(facts.user_end_at)
    if facts.first_audio_at is not None:
        metric["first_audio_at"] = _date(facts.first_audio_at)
    if facts.user_end_at is not None and facts.first_audio_at is not None:
        metric["server_ms"] = _whole(facts.first_audio_at - facts.user_end_at)
    if facts.user_end_at is not None and facts.stt_ms is not None:
        metric["stt_ms"] = _whole(facts.stt_ms)
    if facts.llm_ttft_ms is not None:
        metric["llm_ttft_ms"] = _whole(facts.llm_ttft_ms)
    if facts.tts_ttfb_ms is not None:
        metric["tts_ttfb_ms"] = _whole(facts.tts_ttfb_ms)
    return metric
