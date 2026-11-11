from __future__ import annotations

from datetime import UTC, datetime

from app.metrics.latency import TurnFacts, build_turn_metric, call_id_of_turn


def test_reads_the_call_out_of_an_agent_turn_id() -> None:
    assert call_id_of_turn("ta_c_1b2_7") == "c_1b2"
    assert call_id_of_turn("ta_c1_12") == "c1"


def test_refuses_ids_that_are_not_agent_turn_ids() -> None:
    for id in ("tu_c1_1", "ta_c1", "ta__1", "c1_1", "", "ta_c1_x", "ta_c1_1\n"):
        assert call_id_of_turn(id) is None


def date(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


BASE = {"turn_id": "ta_c1_2", "call_id": "c1"}


def test_computes_server_ms_from_the_user_end_to_the_first_audio_and_keeps_the_stage_timings() -> None:
    metric = build_turn_metric(
        TurnFacts(**BASE, user_end_at=10_000, first_audio_at=11_234.6, stt_ms=300, llm_ttft_ms=410.4, tts_ttfb_ms=180)
    )
    assert metric == {
        **BASE,
        "user_end_at": date(10_000),
        "first_audio_at": date(11_234.6),
        "server_ms": 1235,
        "stt_ms": 300,
        "llm_ttft_ms": 410,
        "tts_ttfb_ms": 180,
    }


def test_has_no_server_ms_without_both_ends_and_no_stt_wait_without_a_user_utterance() -> None:
    assert build_turn_metric(TurnFacts(**BASE, user_end_at=5, first_audio_at=None, stt_ms=300)) == {
        **BASE,
        "user_end_at": date(5),
        "stt_ms": 300,
    }
    assert build_turn_metric(TurnFacts(**BASE, user_end_at=None, first_audio_at=9, stt_ms=300, tts_ttfb_ms=50)) == {
        **BASE,
        "first_audio_at": date(9),
        "tts_ttfb_ms": 50,
    }


def test_never_goes_negative_and_records_nothing_for_a_turn_with_neither_end() -> None:
    clock_step = build_turn_metric(TurnFacts(**BASE, user_end_at=100, first_audio_at=90))
    assert clock_step is not None and clock_step["server_ms"] == 0
    assert build_turn_metric(TurnFacts(**BASE, user_end_at=None, first_audio_at=None, llm_ttft_ms=5)) is None
