"""The usage ledger (D20, P3-T07): one row per billable quantity, priced at insert with the list-price table, so a
session's list-price-equivalent cost is exactly the sum of its rows. Also the daily counters the quota guard reads
(P10-T03). Actual spend is always $0 (free tiers, constraint C1) and is reported separately.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from app.db.repos.rows import to_number
from app.db.repos.usage import UsageEntry, insert_usage
from app.db.tx import Queryable

from .prices import CostCategory, Price, UsageProvider, find_price, list_price_usd


class UnknownPriceError(Exception):
    def __init__(self, provider: str, kind: str) -> None:
        super().__init__(f"no list price for {provider} {kind}; add it to metrics/prices.py with its source")


def _price_of(provider: str, kind: str) -> Price:
    price = find_price(provider, kind)
    if price is None:
        raise UnknownPriceError(provider, kind)
    return price


def _category_of(provider: str, kind: str, unit: str) -> CostCategory:
    """
    The category of a stored row. Rows carry the unit and cost they were priced with, so reading the ledger never
    depends on today's price table: a meter retired since (a model switch) still counts. Its category comes from the
    table while the meter is listed, otherwise from the stored unit.
    """
    listed = find_price(provider, kind)
    if listed:
        return listed.category
    if unit == "second":
        return "stt"
    if unit == "character":
        return "tts"
    return "llm"


async def record_usage(
    db: Queryable, *, session_id: str, provider: UsageProvider, kind: str, units: float, at: datetime | None = None
) -> UsageEntry:
    """Records one meter reading at its list price. Unpriced meters are refused rather than silently costed at $0.

    `kind` is `<model>:<meter>`, e.g. `nova-3:audio` (seconds) or `aura-2:characters`.
    """
    price = _price_of(provider, kind)
    return await insert_usage(
        db,
        session_id=session_id,
        provider=provider,
        kind=kind,
        units=units,
        unit=price.unit,
        cost_usd=list_price_usd(price, units),
        at=at,
    )


async def record_llm_usage(
    db: Queryable,
    *,
    session_id: str,
    provider: Literal["groq", "gemini"],
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int = 0,
    at: datetime | None = None,
) -> list[UsageEntry]:
    """One LLM request: its request count, uncached and cached prompt tokens, and completion tokens.

    From the response's `usage`: prompt tokens include the cached ones.
    """
    for name, value in (
        ("promptTokens", prompt_tokens),
        ("completionTokens", completion_tokens),
        ("cachedTokens", cached_tokens),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a whole number >= 0")
    if cached_tokens > prompt_tokens:
        raise ValueError("cachedTokens can't exceed promptTokens")
    meters: list[tuple[str, int]] = [
        ("requests", 1),
        ("input", prompt_tokens - cached_tokens),
        ("output", completion_tokens),
    ]
    if cached_tokens > 0:
        meters.append(("cachedInput", cached_tokens))
    return [
        await record_usage(db, session_id=session_id, provider=provider, kind=f"{model}:{meter}", units=units, at=at)
        for meter, units in meters
    ]


def _empty_breakdown() -> dict[CostCategory, int | float]:
    return {"stt": 0, "llm": 0, "tts": 0, "vision": 0}


@dataclass(frozen=True, slots=True)
class SessionCost:
    #: List-price equivalent, the record's `costUsd` (architecture section 7).
    cost_usd: int | float
    cost_breakdown_usd: dict[CostCategory, int | float]
    #: Always 0 under C1: every provider is on its free tier.
    actual_spend_usd: int = 0


def _round(value: float) -> float:
    return math.floor(value * 1e8 + 0.5) / 1e8


async def session_cost(db: Queryable, session_id: str) -> SessionCost:
    """A session's list-price cost: the exact sum of its ledger rows (summed in Postgres numeric), by category too."""
    rows = await db.fetch(
        "SELECT provider, kind, unit, sum(cost_usd)::text AS total FROM usage WHERE session_id = $1 GROUP BY provider, kind, unit",
        session_id,
    )
    total = await db.fetchval(
        "SELECT COALESCE(sum(cost_usd), 0)::text AS total FROM usage WHERE session_id = $1", session_id
    )
    breakdown = _empty_breakdown()
    for row in rows:
        category = _category_of(row["provider"], row["kind"], row["unit"])
        breakdown[category] = _round(breakdown[category] + float(row["total"]))
    breakdown = {category: to_number(value) for category, value in breakdown.items()}
    return SessionCost(cost_usd=to_number(total or 0), cost_breakdown_usd=breakdown, actual_spend_usd=0)


@dataclass(slots=True)
class DailyUsage:
    #: The window's start (UTC day, or `now - 24 h` for the rolling window).
    day: str
    #: LLM requests per `<provider>:<model>` (Groq's limits are per model, D06).
    llm_requests: dict[str, int | float] = field(default_factory=dict)
    audio_minutes: int | float = 0
    tts_characters: int | float = 0
    upload_bytes: int | float = 0


def _iso(moment: datetime) -> str:
    """`Date.prototype.toISOString`: UTC, milliseconds, trailing Z."""
    utc = moment.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


async def _usage_between(db: Queryable, start: datetime, end: datetime, label: str) -> DailyUsage:
    rows = await db.fetch(
        "SELECT provider, kind, unit, sum(units)::text AS units FROM usage WHERE at >= $1 AND at < $2 GROUP BY provider, kind, unit",
        start,
        end,
    )
    upload_bytes = await db.fetchval(
        "SELECT COALESCE(sum(size), 0)::text AS bytes FROM files WHERE created_at >= $1 AND created_at < $2", start, end
    )
    usage = DailyUsage(day=label, upload_bytes=to_number(upload_bytes or 0))
    for row in rows:
        units = to_number(row["units"])
        # By the stored unit, so a meter since dropped from the price table still counts against today's quota.
        if row["unit"] == "request":
            usage.llm_requests[f"{row['provider']}:{row['kind'][: -len(':requests')]}"] = units
        elif row["unit"] == "second":
            usage.audio_minutes = to_number(_round(usage.audio_minutes + units / 60))
        elif row["unit"] == "character":
            usage.tts_characters = to_number(usage.tts_characters + units)
    return usage


async def daily_usage(db: Queryable, now: datetime) -> DailyUsage:
    """Usage on the UTC day containing `now`, across all sessions."""
    utc = now.astimezone(UTC)
    start = datetime(utc.year, utc.month, utc.day, tzinfo=UTC)
    end = start + timedelta(days=1)
    return await _usage_between(db, start, end, start.strftime("%Y-%m-%d"))


async def rolling_day_usage(db: Queryable, now: datetime) -> DailyUsage:
    """
    Usage in the 24 hours before `now` (P10-T03's quota guard input). Providers reset their daily quotas at different
    boundaries (UTC midnight, Pacific midnight, a rolling window), and the rolling window is never lower than the
    usage inside any one of them, so the guard errs on the safe side whichever applies.
    """
    start = now - timedelta(hours=24)
    return await _usage_between(db, start, now + timedelta(milliseconds=1), _iso(start))
