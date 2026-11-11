"""Port of server/test/limits/quotaGuard.test.ts (the guard itself and the override route; the call/chat socket cases
need the WebSocket transport and live with its tests): budgets read from the real usage ledger in a rolling 24 h
window, the provider refusal latch, the override, and the wiring: the override route is authenticated and
rate-limited."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.config import Secret
from app.limits.quota_guard import QuotaGuard, QuotaSettings, is_provider_refusal
from app.metrics.usage import record_usage, rolling_day_usage
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.seed import seed_session

TOKEN = "override-token-0123456789abcdef"
HOUR = 60 * 60_000


class Log:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, message: str, **_fields: Any) -> None:
        self.warnings.append(message)

    def info(self, message: str, **_fields: Any) -> None:
        pass


class Rig:
    def __init__(self, db: Any, session_id: str) -> None:
        self.db = db
        self.session_id = session_id
        self.log = Log()

    async def wipe_usage(self) -> None:
        await self.db.pool.execute("DELETE FROM usage")

    async def llm(self, requests: float, at: float, model: str = "openai/gpt-oss-20b", provider: str = "groq") -> None:
        await record_usage(
            self.db.pool,
            session_id=self.session_id,
            provider=provider,  # type: ignore[arg-type]
            kind=f"{model}:requests",
            units=requests,
            at=datetime.fromtimestamp(at / 1000, UTC),
        )

    async def audio(self, seconds: float, at: float) -> None:
        await record_usage(
            self.db.pool,
            session_id=self.session_id,
            provider="deepgram",
            kind="nova-3:audio",
            units=seconds,
            at=datetime.fromtimestamp(at / 1000, UTC),
        )

    def guard(self, now: dict[str, float], **settings: Any) -> QuotaGuard:
        defaults: dict[str, Any] = {
            "llm_requests_per_day": 10,
            "audio_minutes_per_day": 5,
            "override_token": Secret(TOKEN),
        }
        defaults.update(settings)
        return QuotaGuard(self.db.pool, QuotaSettings(**defaults), self.log, lambda: now["t"])


@pytest.fixture
async def rig(db: Any) -> Rig:
    return Rig(db, await seed_session(db.pool))


def now_ms() -> dict[str, float]:
    return {"t": datetime.now(UTC).timestamp() * 1000}


class TestBudgets:
    async def test_allows_calls_below_both_budgets_and_refuses_at_the_llm_request_budget_per_groq_model(
        self, rig: Rig
    ) -> None:
        await rig.wipe_usage()
        now = now_ms()
        await rig.llm(9, now["t"] - HOUR)
        assert await rig.guard(now).check() == {"ok": True}
        await rig.llm(1, now["t"] - 2 * HOUR)  # 10 in the window
        assert await rig.guard(now).check() == {"ok": False, "reason": "llm_budget"}

    async def test_counts_each_groq_model_on_its_own_and_ignores_gemini(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        await rig.llm(6, now["t"] - HOUR, "openai/gpt-oss-20b")
        await rig.llm(6, now["t"] - HOUR, "openai/gpt-oss-120b")
        await rig.llm(50, now["t"] - HOUR, "gemini-flash-lite-latest", "gemini")
        assert await rig.guard(now).check() == {"ok": True}

    async def test_refuses_at_the_audio_minutes_budget(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        await rig.audio(4 * 60, now["t"] - HOUR)
        assert await rig.guard(now).check() == {"ok": True}
        await rig.audio(60, now["t"] - HOUR)
        assert await rig.guard(now).check() == {"ok": False, "reason": "audio_budget"}

    async def test_uses_a_rolling_24_h_window(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        await rig.llm(10, now["t"] - 25 * HOUR)
        assert await rig.guard(now).check() == {"ok": True}
        await rig.llm(10, now["t"] - 23 * HOUR)  # possibly "yesterday" in UTC, still inside 24 h
        assert await rig.guard(now).check() == {"ok": False, "reason": "llm_budget"}
        usage = await rolling_day_usage(rig.db.pool, datetime.fromtimestamp(now["t"] / 1000, UTC))
        assert usage.llm_requests["groq:openai/gpt-oss-20b"] == 10

    async def test_reads_the_ledger_once_per_cache_window_however_many_callers_ask_at_once(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        g = rig.guard(now)
        assert await g.check() == {"ok": True}
        await rig.llm(10, now["t"] - HOUR)
        assert await g.check() == {"ok": True}  # cached
        now["t"] += 16_000  # past the 15 s window
        assert await g.check() == {"ok": False, "reason": "llm_budget"}
        assert g.voice_available() is False
        # The budget frees up (the usage ages out of the window); a stale verdict refreshes itself when asked about.
        await rig.wipe_usage()
        now["t"] += 16_000
        assert g.voice_available() is False  # still the old answer, and a refresh has started
        await asyncio.sleep(0.1)
        assert g.voice_available() is True
        await rig.llm(10, now["t"] - HOUR)
        now["t"] += 16_000
        await g.check()
        concurrent = await asyncio.gather(g.check(), g.check(), g.check())
        assert all(not v["ok"] for v in concurrent)

    async def test_logs_once_when_the_guard_starts_refusing_and_allows_calls_when_the_ledger_cant_be_read(
        self, rig: Rig
    ) -> None:
        await rig.wipe_usage()
        rig.log.warnings.clear()
        now = now_ms()
        await rig.llm(10, now["t"] - HOUR)
        g = rig.guard(now)
        await g.check()
        now["t"] += 16_000
        await g.check()
        assert len([w for w in rig.log.warnings if "new calls refused" in w]) == 1

        class Broken:
            async def fetch(self, *_args: Any) -> Any:
                raise type("DbDown", (Exception,), {"sqlstate": "57P01"})("db down")

            fetchval = fetchrow = execute = fetch

        broken = QuotaGuard(
            Broken(),  # type: ignore[arg-type]
            QuotaSettings(llm_requests_per_day=1, audio_minutes_per_day=1, override_token=None),
            rig.log,
        )
        assert await broken.check() == {"ok": True}
        assert any("could not read the usage ledger" in w for w in rig.log.warnings)


class TestAProviderRefusingUs:
    def test_recognises_401_402_403_and_ws_refused_upgrade_message_and_nothing_else(self) -> None:
        assert is_provider_refusal(SimpleNamespace(status=401)) is True
        assert is_provider_refusal(SimpleNamespace(statusCode=402)) is True
        assert is_provider_refusal(SimpleNamespace(status_code=403)) is True
        assert is_provider_refusal(SimpleNamespace(response=SimpleNamespace(status_code=401))) is True
        assert is_provider_refusal({"status": 401}) is True
        assert is_provider_refusal(Exception("Unexpected server response: 403")) is True
        assert is_provider_refusal(Exception("server rejected WebSocket connection: HTTP 402")) is True
        assert is_provider_refusal(Exception("Unexpected server response: 4031")) is False
        assert is_provider_refusal(SimpleNamespace(status=429)) is False
        assert is_provider_refusal(Exception("Deepgram STT connect timed out")) is False
        assert is_provider_refusal(None) is False

    async def test_latches_for_the_cooldown_then_lets_calls_through_again(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        g = rig.guard(now, provider_cooldown_ms=60_000)
        g.provider_refused("deepgram")
        assert await g.check() == {"ok": False, "reason": "provider_unavailable"}
        assert g.voice_available() is False
        now["t"] += 61_000
        assert await g.check() == {"ok": True}
        assert g.voice_available() is True


class TestTheOverride:
    async def test_lifts_a_budget_refusal_and_a_latch_for_24_h_then_the_guard_applies_again(self, rig: Rig) -> None:
        await rig.wipe_usage()
        now = now_ms()
        await rig.llm(10, now["t"] - HOUR)
        g = rig.guard(now)
        g.provider_refused("deepgram")
        assert (await g.check())["ok"] is False
        assert g.override("wrong-token-wrong-token-wrong") is False
        assert g.override("") is False
        assert (await g.check())["ok"] is False
        assert g.override(TOKEN) is True
        assert await g.check() == {"ok": True}
        assert g.voice_available() is True
        now["t"] += 23 * HOUR
        assert (await g.check())["ok"] is True
        now["t"] += 2 * HOUR  # 25 h later the override has lapsed (and the old usage with it, so add some)
        await rig.llm(10, now["t"] - HOUR)
        assert (await g.check())["ok"] is False

    def test_cant_be_used_when_no_token_is_configured(self, rig: Rig) -> None:
        g = rig.guard(now_ms(), override_token=None)
        assert g.can_override is False
        assert g.override(TOKEN) is False


class TestOverrideRoute:
    @pytest.fixture
    async def served(self, rig: Rig) -> AsyncIterator[tuple[httpx.AsyncClient, QuotaGuard]]:
        guard = QuotaGuard(
            rig.db.pool,
            QuotaSettings(llm_requests_per_day=5, audio_minutes_per_day=5, override_token=Secret(TOKEN), cache_ms=0),
            rig.log,
        )
        async with client_for(build_http_app(rig.db, quota=guard)) as client:
            yield client, guard

    async def test_401_without_or_with_a_wrong_token_200_with_the_token_which_reopens_voice(
        self, served: tuple[httpx.AsyncClient, QuotaGuard], rig: Rig
    ) -> None:
        client, guard = served
        await rig.wipe_usage()
        await rig.llm(5, datetime.now(UTC).timestamp() * 1000 - HOUR)
        assert (await guard.check()) == {"ok": False, "reason": "llm_budget"}
        url = "/api/quota/override"
        assert (await client.post(url)).status_code == 401
        assert (await client.post(url, headers={"authorization": "Bearer nope"})).status_code == 401
        assert (await client.post(url, headers={"authorization": TOKEN})).status_code == 401
        ok = await client.post(url, headers={"authorization": f"Bearer {TOKEN}"})
        assert ok.status_code == 200
        assert ok.json() == {"overridden": True}
        assert ok.headers["cache-control"] == "no-store"
        assert await guard.check() == {"ok": True}

    async def test_the_override_route_is_rate_limited_5_tries_a_minute_and_absent_when_no_token_is_configured(
        self, served: tuple[httpx.AsyncClient, QuotaGuard], rig: Rig
    ) -> None:
        client, _ = served
        url = "/api/quota/override"
        codes = [(await client.post(url, headers={"authorization": "Bearer nope"})).status_code for _ in range(8)]
        assert 429 in codes
        assert codes[:5] == [401] * 5
        limited = await client.post(url, headers={"authorization": "Bearer nope"})
        assert limited.json() == {"error": "rate_limited", "message": "Too many attempts."}
        async with client_for(build_http_app(rig.db)) as bare:
            assert (await bare.post(url)).status_code == 404
