"""The usage ledger and price table (P3-T07; D20): cost math against fixed samples, exact to 6 decimal places;
every price has a source and a date; the daily counters match the inserted rows.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest

from app.db.repos.usage import insert_usage, list_usage
from app.metrics.prices import PRICES, Rate, find_price, list_price_usd
from app.metrics.usage import (
    UnknownPriceError,
    daily_usage,
    record_llm_usage,
    record_usage,
    rolling_day_usage,
    session_cost,
)
from tests.repos.seed import seed_session


def test_price_table_gives_every_price_a_pricing_page_source_a_check_date_and_a_positive_per_quantity() -> None:
    assert len(PRICES) > 0
    for price in PRICES:
        assert re.match(r"^https://[a-z.]+\.(com|dev)/", price.source), price.kind
        assert re.match(r"^\d{4}-\d{2}-\d{2}$", price.checked_on), price.kind
        assert price.per > 0, price.kind
        assert price.usd >= 0, price.kind
    assert len({f"{p.provider} {p.kind}" for p in PRICES}) == len(PRICES)


def test_price_table_covers_every_model_in_the_approved_stack() -> None:
    for provider, kind in (
        ("deepgram", "nova-3:audio"),
        ("deepgram", "aura-2:characters"),
        ("groq", "openai/gpt-oss-20b:input"),
        ("groq", "openai/gpt-oss-20b:output"),
        ("groq", "openai/gpt-oss-120b:input"),
        ("gemini", "gemini-flash-lite-latest:output"),
    ):
        assert find_price(provider, kind) is not None, kind


def test_price_table_is_identical_to_the_ts_table() -> None:
    summary = [(p.provider, p.kind, p.unit, p.category, p.usd, p.per) for p in PRICES]
    assert summary == [
        ("deepgram", "nova-3:audio", "second", "stt", 0.0077, 60),
        ("deepgram", "aura-2:characters", "character", "tts", 0.03, 1000),
        ("groq", "openai/gpt-oss-20b:input", "token", "llm", 0.075, 1_000_000),
        ("groq", "openai/gpt-oss-20b:cachedInput", "token", "llm", 0.075, 1_000_000),
        ("groq", "openai/gpt-oss-20b:output", "token", "llm", 0.3, 1_000_000),
        ("groq", "openai/gpt-oss-20b:requests", "request", "llm", 0, 1),
        ("groq", "openai/gpt-oss-120b:input", "token", "llm", 0.15, 1_000_000),
        ("groq", "openai/gpt-oss-120b:cachedInput", "token", "llm", 0.15, 1_000_000),
        ("groq", "openai/gpt-oss-120b:output", "token", "llm", 0.6, 1_000_000),
        ("groq", "openai/gpt-oss-120b:requests", "request", "llm", 0, 1),
        ("gemini", "gemini-flash-lite-latest:input", "token", "llm", 0.3, 1_000_000),
        ("gemini", "gemini-flash-lite-latest:cachedInput", "token", "llm", 0.03, 1_000_000),
        ("gemini", "gemini-flash-lite-latest:output", "token", "llm", 2.5, 1_000_000),
        ("gemini", "gemini-flash-lite-latest:requests", "request", "llm", 0, 1),
    ]
    assert {p.checked_on for p in PRICES} == {"2026-11-10"}
    assert {p.source for p in PRICES if p.provider == "deepgram"} == {"https://deepgram.com/pricing"}
    assert {p.source for p in PRICES if p.provider == "groq"} == {"https://console.groq.com/docs/models"}
    assert {p.source for p in PRICES if p.provider == "gemini"} == {"https://ai.google.dev/gemini-api/docs/pricing"}


def test_computes_list_price_cost_from_the_published_rates() -> None:
    assert list_price_usd(Rate(usd=0.0077, per=60), 60) == 0.0077  # one minute of Nova-3
    assert list_price_usd(Rate(usd=0.03, per=1000), 1000) == 0.03  # 1,000 Aura-2 characters
    assert list_price_usd(Rate(usd=0.3, per=1_000_000), 1) == 0.0000003  # one token is still counted
    assert list_price_usd(Rate(usd=1, per=3), 1) == 0.33333333  # rounded to the ledger's 8 decimals


async def test_prices_each_row_at_insert_and_the_session_cost_is_exactly_the_sum_of_its_rows(db) -> None:
    session_id = await seed_session(db.pool)
    # A fixed sample session: ~3.5 minutes of audio, 1,840 TTS characters, 6 LLM requests, one of them on the fallback.
    await record_usage(db.pool, session_id=session_id, provider="deepgram", kind="nova-3:audio", units=212.4)
    await record_usage(db.pool, session_id=session_id, provider="deepgram", kind="aura-2:characters", units=1840)
    for i in range(5):
        await record_llm_usage(
            db.pool,
            session_id=session_id,
            provider="groq",
            model="openai/gpt-oss-20b",
            prompt_tokens=1800 + i,
            completion_tokens=120,
            cached_tokens=1024,
        )
    await record_llm_usage(
        db.pool,
        session_id=session_id,
        provider="groq",
        model="openai/gpt-oss-120b",
        prompt_tokens=1900,
        completion_tokens=150,
    )
    # Expected, by hand from the published rates.
    stt = (212.4 * 0.0077) / 60
    tts = (1840 * 0.03) / 1000
    llm = 0.0
    for i in range(5):
        llm += ((1800 + i - 1024) * 0.075 + 1024 * 0.075 + 120 * 0.3) / 1e6
    llm += (1900 * 0.15 + 150 * 0.6) / 1e6
    cost = await session_cost(db.pool, session_id)
    rows = await list_usage(db.pool, session_id)
    sum_of_rows = sum(row.cost_usd for row in rows)
    assert f"{cost.cost_usd:.6f}" == f"{sum_of_rows:.6f}"
    assert f"{cost.cost_usd:.6f}" == f"{stt + tts + llm:.6f}"
    assert f"{cost.cost_breakdown_usd['stt']:.6f}" == f"{stt:.6f}"
    assert f"{cost.cost_breakdown_usd['tts']:.6f}" == f"{tts:.6f}"
    assert f"{cost.cost_breakdown_usd['llm']:.6f}" == f"{llm:.6f}"
    assert cost.cost_breakdown_usd["vision"] == 0
    assert cost.actual_spend_usd == 0  # free tiers (C1)
    # Every row carries its unit; request rows are free counters.
    assert {r.unit for r in rows} == {"second", "character", "token", "request"}
    assert all(r.cost_usd == 0 for r in rows if r.unit == "request")


async def test_a_session_with_no_usage_costs_0(db) -> None:
    cost = await session_cost(db.pool, await seed_session(db.pool))
    assert (cost.cost_usd, cost.cost_breakdown_usd, cost.actual_spend_usd) == (
        0,
        {"stt": 0, "llm": 0, "tts": 0, "vision": 0},
        0,
    )


async def test_refuses_unpriced_meters_and_impossible_token_counts_instead_of_recording_them_at_0(db) -> None:
    session_id = await seed_session(db.pool)
    with pytest.raises(UnknownPriceError):
        await record_usage(db.pool, session_id=session_id, provider="groq", kind="llama-x:input", units=10)
    with pytest.raises(ValueError):
        await record_llm_usage(
            db.pool,
            session_id=session_id,
            provider="groq",
            model="openai/gpt-oss-20b",
            prompt_tokens=10,
            completion_tokens=1,
            cached_tokens=11,
        )
    with pytest.raises(ValueError):
        await record_llm_usage(
            db.pool,
            session_id=session_id,
            provider="groq",
            model="openai/gpt-oss-20b",
            prompt_tokens=1.5,
            completion_tokens=1,  # type: ignore[arg-type]
        )
    with pytest.raises(ValueError):
        await record_usage(db.pool, session_id=session_id, provider="deepgram", kind="nova-3:audio", units=-1)
    assert await list_usage(db.pool, session_id) == []


async def test_rows_of_a_meter_no_longer_in_the_price_table_still_count(db) -> None:
    day = datetime(2032, 5, 6, 12, tzinfo=UTC)
    id = await seed_session(db.pool)
    await record_usage(db.pool, session_id=id, provider="deepgram", kind="nova-3:audio", units=60, at=day)
    # Priced when written (the rows carry their cost and unit); the price table no longer has these kinds.
    await insert_usage(
        db.pool, session_id=id, provider="groq", kind="retired-model:requests", units=1, unit="request", at=day
    )
    await insert_usage(
        db.pool,
        session_id=id,
        provider="groq",
        kind="retired-model:input",
        units=1000,
        unit="token",
        cost_usd=0.0001,
        at=day,
    )
    await insert_usage(
        db.pool,
        session_id=id,
        provider="deepgram",
        kind="nova-2:audio",
        units=120,
        unit="second",
        cost_usd=0.0086,
        at=day,
    )
    await insert_usage(
        db.pool,
        session_id=id,
        provider="deepgram",
        kind="aura-1:characters",
        units=40,
        unit="character",
        cost_usd=0.0006,
        at=day,
    )
    assert find_price("groq", "retired-model:input") is None
    cost = await session_cost(db.pool, id)
    assert cost.cost_usd == pytest.approx(0.0077 + 0.0001 + 0.0086 + 0.0006, abs=5e-7)
    assert cost.cost_breakdown_usd["llm"] == pytest.approx(0.0001, abs=5e-7)
    assert cost.cost_breakdown_usd["stt"] == pytest.approx(0.0077 + 0.0086, abs=5e-7)
    assert cost.cost_breakdown_usd["tts"] == pytest.approx(0.0006, abs=5e-7)
    usage = await daily_usage(db.pool, day)
    assert usage.llm_requests == {"groq:retired-model": 1}
    assert (usage.audio_minutes, usage.tts_characters) == (3, 40)


async def test_counts_the_utc_days_llm_requests_per_model_audio_minutes_tts_characters_and_upload_bytes(db) -> None:
    day = datetime(2031, 3, 4, 12, tzinfo=UTC)
    in_day = datetime(2031, 3, 4, 0, tzinfo=UTC)
    before = datetime(2031, 3, 3, 23, 59, 59, tzinfo=UTC)
    a = await seed_session(db.pool)
    b = await seed_session(db.pool)
    await record_usage(db.pool, session_id=a, provider="deepgram", kind="nova-3:audio", units=90, at=in_day)
    await record_usage(db.pool, session_id=b, provider="deepgram", kind="nova-3:audio", units=30, at=day)
    await record_usage(
        db.pool, session_id=a, provider="deepgram", kind="nova-3:audio", units=600, at=before
    )  # the day before
    await record_usage(db.pool, session_id=b, provider="deepgram", kind="aura-2:characters", units=500, at=day)
    await record_llm_usage(
        db.pool,
        session_id=a,
        provider="groq",
        model="openai/gpt-oss-20b",
        prompt_tokens=10,
        completion_tokens=1,
        at=day,
    )
    await record_llm_usage(
        db.pool,
        session_id=b,
        provider="groq",
        model="openai/gpt-oss-20b",
        prompt_tokens=10,
        completion_tokens=1,
        at=day,
    )
    await record_llm_usage(
        db.pool,
        session_id=b,
        provider="gemini",
        model="gemini-flash-lite-latest",
        prompt_tokens=10,
        completion_tokens=1,
        at=day,
    )
    await insert_usage(
        db.pool, session_id=a, provider="groq", kind="openai/gpt-oss-120b:requests", units=1, unit="request", at=before
    )
    await db.pool.execute(
        "INSERT INTO files (id, session_id, mime, size, sha256, created_at) VALUES ('fDay0000001', $1, 'application/pdf', 1000, $2, $3)",
        a,
        "a" * 64,
        day,
    )
    await db.pool.execute(
        "INSERT INTO files (id, session_id, mime, size, sha256) VALUES ('fToday00001', $1, 'image/png', 7, $2)",
        a,
        "b" * 64,
    )  # today, not 2031
    usage = await daily_usage(db.pool, day)
    assert (usage.day, usage.llm_requests, usage.audio_minutes, usage.tts_characters, usage.upload_bytes) == (
        "2031-03-04",
        {"groq:openai/gpt-oss-20b": 2, "gemini:gemini-flash-lite-latest": 1},
        2,
        500,
        1000,
    )


async def test_rolling_day_usage_covers_the_24_hours_before_now(db) -> None:
    now = datetime(2033, 3, 4, 12, 0, 0, tzinfo=UTC)
    a = await seed_session(db.pool)
    await record_usage(
        db.pool,
        session_id=a,
        provider="deepgram",
        kind="nova-3:audio",
        units=60,
        at=datetime(2033, 3, 3, 12, 0, 0, tzinfo=UTC),
    )
    await record_usage(
        db.pool,
        session_id=a,
        provider="deepgram",
        kind="nova-3:audio",
        units=60,
        at=datetime(2033, 3, 3, 11, 59, 59, tzinfo=UTC),
    )
    await record_usage(db.pool, session_id=a, provider="deepgram", kind="aura-2:characters", units=7, at=now)
    usage = await rolling_day_usage(db.pool, now)
    assert (usage.day, usage.audio_minutes, usage.tts_characters) == ("2033-03-03T12:00:00.000Z", 1, 7)
