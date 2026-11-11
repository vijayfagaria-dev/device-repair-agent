"""Paid-tier list prices (D20, P3-T07). Actual spend is $0: every provider runs on its free tier (constraint C1).

These rates turn the usage ledger into a "list-price equivalent": what the same usage would cost on each
provider's published pay-as-you-go plan. Each entry names its source page and the date it was read.
Neon (database) and Render (hosting) are $0 at this scale and have no meters here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

CostCategory = Literal["stt", "llm", "tts", "vision"]
UsageProvider = Literal["deepgram", "groq", "gemini"]
PriceUnit = Literal["second", "character", "token", "request"]


@dataclass(frozen=True, slots=True)
class Price:
    provider: UsageProvider
    #: The ledger's `kind`: `<model>:<meter>`.
    kind: str
    #: What `units` counts in the ledger.
    unit: PriceUnit
    category: CostCategory
    #: The published rate: `usd` per `per` units (e.g. $0.0077 per 60 seconds).
    usd: float
    per: float
    source: str
    #: When the rate was read from `source` (YYYY-MM-DD).
    checked_on: str
    note: str | None = None


CHECKED_ON = "2026-11-10"
DEEPGRAM = "https://deepgram.com/pricing"
GROQ = "https://console.groq.com/docs/models"
GEMINI = "https://ai.google.dev/gemini-api/docs/pricing"
MILLION = 1_000_000


def _llm(
    provider: Literal["groq", "gemini"],
    model: str,
    input: float,
    output: float,
    cached_input: float,
    source: str,
    note: str | None = None,
) -> list[Price]:
    """LLM models (D06): the primary, the Groq fallback and the Gemini last resort. Request counts are free meters."""

    def token(kind: str, usd: float) -> Price:
        return Price(provider, f"{model}:{kind}", "token", "llm", usd, MILLION, source, CHECKED_ON, note)

    return [
        token("input", input),
        token("cachedInput", cached_input),
        token("output", output),
        Price(
            provider,
            f"{model}:requests",
            "request",
            "llm",
            0,
            1,
            source,
            CHECKED_ON,
            "request count for the daily quota guard; not billed",
        ),
    ]


_GROQ_NOTE = "Groq lists no cached-input rate; cached tokens are priced at the input rate (an upper bound)"

_LIST: list[Price] = [
    Price(
        "deepgram",
        "nova-3:audio",
        "second",
        "stt",
        0.0077,
        60,
        DEEPGRAM,
        CHECKED_ON,
        "Nova-3 Monolingual streaming, Pay as you go: $0.0077/min, billed per second with no rounding",
    ),
    Price(
        "deepgram",
        "aura-2:characters",
        "character",
        "tts",
        0.03,
        1000,
        DEEPGRAM,
        CHECKED_ON,
        "Aura-2, Pay as you go: $0.030 per 1,000 characters of input text",
    ),
    *_llm("groq", "openai/gpt-oss-20b", 0.075, 0.3, 0.075, GROQ, _GROQ_NOTE),
    *_llm("groq", "openai/gpt-oss-120b", 0.15, 0.6, 0.15, GROQ, _GROQ_NOTE),
    *_llm(
        "gemini",
        "gemini-flash-lite-latest",
        0.3,
        2.5,
        0.03,
        GEMINI,
        "paid Standard tier of Gemini 3.5 Flash-Lite, the newest Flash-Lite listed; Google doesn't publish which model "
        "the -latest alias points to",
    ),
]

PRICES: tuple[Price, ...] = tuple(_LIST)


def find_price(provider: str, kind: str) -> Price | None:
    return next((price for price in PRICES if price.provider == provider and price.kind == kind), None)


#: Cost decimals stored in usage.cost_usd (numeric(14, 8)).
COST_DECIMALS = 8


@dataclass(frozen=True, slots=True)
class Rate:
    """Anything with `usd` and `per` (the TS took `Pick<Price, "usd" | "per">`); a `Price` fits too."""

    usd: float
    per: float


def list_price_usd(price: Price | Rate, units: float) -> float:
    """List-price cost of `units` at `price`, rounded to the ledger's precision (JS `Math.round` semantics)."""
    scale = 10**COST_DECIMALS
    return math.floor(((units * price.usd) / price.per) * scale + 0.5) / scale
