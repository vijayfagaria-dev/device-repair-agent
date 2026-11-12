"""The cost and latency report (P11-T03): numbers from seeded rows, the synthetic split, the gate, and the CLI."""

from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import asyncpg
import pytest

from app.db.pool import Database
from app.db.repos.calls import insert_call
from app.db.repos.turn_metrics import upsert_turn_metric
from app.metrics.usage import record_llm_usage, record_usage
from tests.repos.seed import seed_session

_SPEC = importlib.util.spec_from_file_location("report", Path(__file__).resolve().parents[2] / "scripts" / "report.py")
assert _SPEC and _SPEC.loader
report: ModuleType = importlib.util.module_from_spec(_SPEC)
sys.modules["report"] = report
_SPEC.loader.exec_module(report)

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)


def options(**kw: object) -> object:
    base: dict[str, object] = {"region": "Render | Virginia", "browsers": "Chrome 131", "headphones": "yes", "now": NOW}
    return report.ReportOptions(**{**base, **kw})


async def finalize(db: Database, session_id: str, outcome: str = "completed") -> None:
    await db.pool.execute("UPDATE sessions SET status = 'finalized', outcome = $2 WHERE id = $1", session_id, outcome)


async def seed(db: Database, *, turns: int, cost: bool = True, outcome: str = "completed") -> str:
    """A finalized session with one call, `turns` voice turns (server_ms 100, 200, ...) and some ledger rows."""
    sid = await seed_session(db.pool)
    await insert_call(db.pool, id=f"c_{sid[:8]}", session_id=sid)
    for i in range(turns):
        await upsert_turn_metric(
            db.pool,
            turn_id=f"ta_c_{sid[:8]}_{i}",
            session_id=sid,
            call_id=f"c_{sid[:8]}",
            server_ms=100 * (i + 1),
            stt_ms=10,
            llm_ttft_ms=20,
            tts_ttfb_ms=30,
            client_ms=500 if i == 0 else None,
        )
    if cost:
        await record_usage(db.pool, session_id=sid, provider="deepgram", kind="nova-3:audio", units=60)
        await record_llm_usage(
            db.pool,
            session_id=sid,
            provider="groq",
            model="openai/gpt-oss-20b",
            prompt_tokens=1000,
            completion_tokens=100,
            cached_tokens=400,
        )
    await finalize(db, sid, outcome)
    return sid


async def read_only_report(db: Database, opts: object) -> tuple[str, object]:
    async with db.pool.acquire() as conn, conn.transaction(readonly=True):
        data = await report.collect(conn, opts)
    return report.render_markdown(data), data


async def test_reports_cost_latency_and_the_gate_from_seeded_rows(db: Database) -> None:
    for _ in range(3):
        await seed(db, turns=4)
    await seed(db, turns=2, cost=False, outcome="partial")  # not completed: no cost, its turns still count
    markdown, data = await read_only_report(db, options())

    real = data.real
    assert (real.sessions, real.completed_sessions) == (4, 3)
    # Per session: 60 s of nova-3 (0.0077) + 600 input tokens * 0.075/M + 400 cached * 0.075/M + 100 out * 0.3/M
    expected = 0.0077 + 600 * 0.075 / 1e6 + 400 * 0.075 / 1e6 + 100 * 0.3 / 1e6
    assert real.cost.mean_usd == pytest.approx(expected)
    assert real.cost.median_usd == pytest.approx(expected)
    assert real.cost.by_provider_usd["deepgram"] == pytest.approx(0.0077)
    assert (real.cost.llm_requests, real.cost.cache_read_requests, real.cost.sessions_with_cache_read) == (3, 3, 3)
    assert real.latency.turns == 14
    assert real.latency.calls == 4
    assert real.latency.server_ms.n == 14
    assert real.latency.server_ms.p50 == 200  # nearest rank: ceil(.5 * 14) = 7th smallest of 2x100, 4x200, ...
    assert real.latency.server_ms.max == 400
    assert real.latency.client_ms.n == 4

    assert "# Cost and latency measurements" in markdown
    assert "- Region: Render Virginia." in markdown
    assert "- Headphones: yes." in markdown
    assert "n = 3 completed sessions." in markdown
    assert "n = 14 turns across 4 calls." in markdown
    assert "Cost: n ≥ 10 completed sessions: **NOT met** (n = 3)." in markdown
    assert "Latency: n ≥ 50 turns: **NOT met** (n = 14)." in markdown
    assert "Prompt cache: 3 of 3 LLM requests" in markdown
    assert not report.gate_met(real)


async def test_synthetic_sessions_are_reported_apart_and_the_gate_counts_only_real_ones(db: Database) -> None:
    real = [await seed(db, turns=5) for _ in range(10)]
    synthetic = await seed(db, turns=3)
    _, data = await read_only_report(db, options(synthetic=frozenset({synthetic})))
    assert (data.real.sessions, data.synthetic.sessions) == (10, 1)
    assert data.synthetic.latency.turns == 3
    assert data.real.latency.turns == 50
    assert report.gate_met(data.real)
    assert len(real) == 10


async def test_gate_needs_both_ten_completed_sessions_and_fifty_turns(db: Database) -> None:
    for _ in range(10):
        await seed(db, turns=4)  # 40 turns
    _, data = await read_only_report(db, options())
    assert (data.real.cost.sessions, data.real.latency.turns) == (10, 40)
    assert not report.gate_met(data.real)


async def test_window_filters_sessions_by_creation_time(db: Database) -> None:
    sid = await seed(db, turns=1)
    await db.pool.execute("UPDATE sessions SET created_at = $2 WHERE id = $1", sid, datetime(2026, 1, 1, tzinfo=UTC))
    await seed(db, turns=1)
    _, data = await read_only_report(db, options(from_=datetime(2026, 6, 1, tzinfo=UTC)))
    assert data.real.sessions == 1
    _, data = await read_only_report(db, options(to=datetime(2026, 6, 1, tzinfo=UTC)))
    assert data.real.sessions == 1


async def test_an_empty_database_reports_no_sessions_and_the_gate_not_met(db: Database) -> None:
    markdown, data = await read_only_report(db, options())
    assert data.real.sessions == 0
    assert "No completed sessions." in markdown
    assert "n = 0 turns across 0 calls." in markdown
    assert "NOT met" in markdown


async def test_report_transaction_is_read_only(db: Database) -> None:
    async with db.pool.acquire() as conn, conn.transaction(readonly=True):
        await report.collect(conn, options())
        with pytest.raises(asyncpg.ReadOnlySQLTransactionError):
            await conn.execute("DELETE FROM usage")


def test_main_refuses_with_exit_3_when_under_the_minimums_and_never_prints_the_url(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_run(url: str, opts: object) -> tuple[str, bool]:
        return "# report\nNOT met", False

    monkeypatch.setattr(report, "run", fake_run)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@host/db")
    code = report.main(["--region", "x", "--browsers", "y", "--headphones", "no"])
    out = capsys.readouterr()
    assert code == 3
    assert "NOT met" in out.out
    assert "gate not met" in out.err
    assert "secret" not in out.out + out.err

    async def failing_run(url: str, opts: object) -> tuple[str, bool]:
        raise ConnectionError("cannot connect to postgresql://user:secret@host/db")

    monkeypatch.setattr(report, "run", failing_run)
    assert report.main(["--region", "x", "--browsers", "y", "--headphones", "no"]) == 1
    assert "secret" not in capsys.readouterr().err


def test_main_exits_2_without_database_url_or_with_bad_arguments(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert report.main(["--region", "x", "--browsers", "y", "--headphones", "yes"]) == 2
    assert "DATABASE_URL is not set" in capsys.readouterr().err
    for argv in (["--region", "x", "--browsers", "y"], ["--region", "x", "--browsers", "y", "--headphones", "maybe"]):
        with pytest.raises(SystemExit) as exit_info:
            report.main(argv)
        assert exit_info.value.code == 2
    with pytest.raises(SystemExit):
        report.main(["--region", "  ", "--browsers", "y", "--headphones", "no"])


def test_synthetic_file_ids_are_validated_and_comments_ignored() -> None:
    sid = "0b8f6f0e-6c3b-4a8a-9d75-1c2d3e4f5a6b"
    assert report.read_synthetic_ids(f"# header\n{sid.upper()}  # run 1\n\n") == frozenset({sid})
    with pytest.raises(ValueError, match="not a session id"):
        report.read_synthetic_ids("nope")


def test_percentile_is_nearest_rank_and_never_interpolated() -> None:
    values = [1.0, 2.0, 3.0, 4.0]
    assert report.percentile(values, 50) == 2.0
    assert report.percentile(values, 95) == 4.0
    assert report.percentile([], 50) is None
    assert report.median(values) == 2.5
