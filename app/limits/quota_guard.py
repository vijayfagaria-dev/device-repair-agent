"""The free-tier quota guard (P10-T03, architecture sections 8 and 9).

The URL is public and every provider is on a free tier, so running out mid-review would look like downtime. Before a
call starts, the guard reads the usage ledger (P3-T07) and refuses new calls (close 4429 `quota`, chat keeps working)
once either budget is spent:

- LLM requests: the busiest Groq model in the last 24 h against DAILY_LLM_REQUEST_BUDGET (Groq's limit is per model);
- Deepgram audio minutes in the last 24 h against DAILY_AUDIO_MINUTES_BUDGET.

A provider that refuses us outright (Deepgram 401/402/403: key revoked or credit gone) latches the guard for a cooldown,
so each new caller doesn't spend a connection attempt finding out. The owner can lift the guard for 24 h with
QUOTA_OVERRIDE_TOKEN (POST /api/quota/override). The window is rolling, not a calendar day: providers reset at different
times and the rolling count is never below the count inside any one of them.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, TypedDict

from app.config import Secret
from app.db.tx import Queryable
from app.metrics.usage import DailyUsage, rolling_day_usage

QuotaRefusal = Literal["llm_budget", "audio_budget", "provider_unavailable"]


class QuotaVerdict(TypedDict, total=False):
    """`{"ok": True}` or `{"ok": False, "reason": QuotaRefusal}` (the TS discriminated union, as a dict)."""

    ok: bool
    reason: QuotaRefusal


@dataclass(frozen=True, slots=True)
class QuotaSettings:
    #: LLM requests per Groq model per rolling 24 h.
    llm_requests_per_day: int
    audio_minutes_per_day: int
    override_token: Secret | None
    #: How long a ledger reading is reused (default 15 s: one query per window, however many callers).
    cache_ms: float = 15_000
    #: How long a provider refusal (401/402/403) keeps calls refused (default 10 min).
    provider_cooldown_ms: float = 10 * 60_000
    #: How long an override lifts the guard (default 24 h).
    override_ms: float = 24 * 60 * 60_000


class QuotaLog(Protocol):
    def warning(self, event: str, **fields: Any) -> Any: ...
    def info(self, event: str, **fields: Any) -> Any: ...


_UNEXPECTED = re.compile(r"(?:Unexpected server response:|HTTP) (401|402|403)\b")


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def _status_of(error: Any) -> Any:
    if error is None:
        return None
    for name in ("status", "statusCode", "status_code"):
        value = error.get(name) if isinstance(error, dict) else getattr(error, name, None)
        if value is not None:
            return value
    response = error.get("response") if isinstance(error, dict) else getattr(error, "response", None)
    if response is not None:
        return getattr(response, "status_code", None)
    return None


def is_provider_refusal(error: Any) -> bool:
    """Provider errors that mean "we are not allowed", not "try again": a bad or revoked key, or no credit left."""
    if _status_of(error) in (401, 402, 403):
        return True
    # A refused WebSocket upgrade is reported as "Unexpected server response: 401" (ws) / "... HTTP 401" (websockets).
    message = error.get("message") if isinstance(error, dict) else getattr(error, "message", None)
    if message is None and isinstance(error, BaseException):
        message = str(error)
    return isinstance(message, str) and _UNEXPECTED.search(message) is not None


def _wall_ms() -> float:
    return time.time() * 1000


class QuotaGuard:
    def __init__(
        self, db: Queryable, settings: QuotaSettings, log: QuotaLog, now: Callable[[], float] = _wall_ms
    ) -> None:
        self._db = db
        self._settings = settings
        self._log = log
        self._now = now
        self._verdict: QuotaVerdict = {"ok": True}
        self._read_at = float("-inf")
        self._reading: asyncio.Task[QuotaVerdict] | None = None
        self._latched_until = 0.0
        self._overridden_until = 0.0
        self._background: set[asyncio.Task[Any]] = set()

    @property
    def can_override(self) -> bool:
        """Whether QUOTA_OVERRIDE_TOKEN is configured (the override route exists only then)."""
        return self._settings.override_token is not None

    @property
    def overridden(self) -> bool:
        """True while an override is in force."""
        return self._now() < self._overridden_until

    async def check(self) -> QuotaVerdict:
        """Whether a call may start now. Reads the ledger at most once per `cache_ms`.

        If the ledger can't be read, the call is allowed (a database outage already fails the call itself; locking
        everyone out on a blip would be worse).
        """
        if self.overridden:
            return {"ok": True}
        if self._now() < self._latched_until:
            return {"ok": False, "reason": "provider_unavailable"}
        if self._now() - self._read_at < self._settings.cache_ms:
            return self._verdict
        if self._reading is None:
            self._reading = asyncio.ensure_future(self._read_and_clear())
        return await asyncio.shield(self._reading)

    def voice_available(self) -> bool:
        """What the client is told in `sessionState.voiceAvailable`: the last verdict, without waiting for the database.

        A stale verdict starts a refresh in the background (at most one per cache window), so a "voice unavailable"
        notice doesn't outlive the budget; the client learns the new value when its next state message goes out.
        """
        if self.overridden:
            return True
        if self._now() - self._read_at >= self._settings.cache_ms:
            task = asyncio.ensure_future(self.check())
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        if self._now() < self._latched_until:
            return False
        return bool(self._verdict["ok"])

    async def _read_and_clear(self) -> QuotaVerdict:
        try:
            return await self._read()
        finally:
            self._reading = None

    async def _read(self) -> QuotaVerdict:
        try:
            usage: DailyUsage = await rolling_day_usage(self._db, datetime.fromtimestamp(self._now() / 1000, UTC))
        except Exception as err:
            self._log.warning(
                "quota guard could not read the usage ledger; allowing the call",
                code=getattr(err, "sqlstate", None) or getattr(err, "code", None),
                err=str(err),
            )
            return {"ok": True}
        groq = [(name, count) for name, count in usage.llm_requests.items() if name.startswith("groq:")]
        busiest: tuple[str, float] = ("", 0)
        for entry in groq:
            if entry[1] > busiest[1]:
                busiest = entry
        verdict: QuotaVerdict = {"ok": True}
        if busiest[1] >= self._settings.llm_requests_per_day:
            verdict = {"ok": False, "reason": "llm_budget"}
        elif usage.audio_minutes >= self._settings.audio_minutes_per_day:
            verdict = {"ok": False, "reason": "audio_budget"}
        if not verdict["ok"] and self._verdict["ok"]:
            self._log.warning(
                "quota guard: new calls refused",
                reason=verdict["reason"],
                model=busiest[0] or None,
                requests=busiest[1],
                audioMinutes=usage.audio_minutes,
            )
        self._verdict = verdict
        self._read_at = self._now()
        return verdict

    def provider_refused(self, provider: str) -> None:
        """A provider refused our credentials or credit: refuse calls for a cooldown instead of failing each one."""
        if self.overridden:
            return
        self._latched_until = self._now() + self._settings.provider_cooldown_ms
        self._log.warning(
            "quota guard: a provider refused the request; new calls refused for the cooldown",
            provider=provider,
            cooldownMs=self._settings.provider_cooldown_ms,
        )

    def override(self, token: str) -> bool:
        """Lifts the guard for `override_ms` when `token` is the configured override token (constant-time compare)."""
        configured = self._settings.override_token
        if configured is None or not hmac.compare_digest(_digest(token), _digest(configured.reveal())):
            return False
        self._overridden_until = self._now() + self._settings.override_ms
        self._latched_until = 0.0
        self._read_at = float("-inf")
        self._log.info("quota guard: overridden by the owner", untilMs=self._overridden_until)
        return True
