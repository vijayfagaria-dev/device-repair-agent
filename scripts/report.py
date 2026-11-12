"""Cost and latency report (P11-T03, D20): reads the production database, read-only, and prints a markdown report.

    DATABASE_URL=<Neon URL> uv run python scripts/report.py --region "Render Virginia / user in India" \
        --browsers "Chrome 131" --headphones yes [--from 2026-11-12] [--to 2026-11-20] \
        [--synthetic-file synthetic-sessions.txt] [--out report.md]

What it says and doesn't:
 * Cost: completed sessions only (`sessions.status = 'finalized'`, `outcome = 'completed'`), the list-price equivalent
   summed from the usage ledger (actual spend is $0 on the free tiers). Mean, median, and the per-provider split.
 * Latency: every agent turn that follows a user utterance (server ms = STT's end-of-utterance event -> first audio
   frame written to the socket), p50/p95 by nearest rank (an observed value, never interpolated), plus the stage
   timings and the browser's own number, reported separately.
 * Real-user and synthetic sessions are reported apart. The database can't tell them apart, so the operator lists the
   synthetic session ids (one per line) in --synthetic-file; everything else counts as a real user.
 * Region, browsers and headphones are not in the database: they are required arguments, printed as given.
 * Nothing here is an estimate. With too few samples the report still prints the numbers it has, says n, says the gate
   is not met, and exits 3.

DATABASE_URL comes from the environment only and is never printed. Exit 0 with the report on stdout (or in --out) when
the gate is met, 3 when it is not, 2 for bad arguments or a missing DATABASE_URL, 1 for a failure.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

if __name__ == "__main__":  # `python scripts/report.py` puts scripts/ on sys.path, not the repo root
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncpg

from app.db.pool import connection_settings
from app.db.tx import Queryable
from app.metrics.latency import js_round

#: The P11 gate (implementation plan): enough completed real-user sessions and real-user turns.
GATE_COMPLETED_SESSIONS = 10
GATE_TURNS = 50

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


@dataclass(frozen=True, slots=True)
class ReportOptions:
    region: str
    browsers: str
    headphones: str  # "yes" | "no"
    now: datetime
    #: Sessions created from this instant (inclusive), or all.
    from_: datetime | None = None
    #: Sessions created before this instant (exclusive), or all.
    to: datetime | None = None
    #: Session ids to report as synthetic runs.
    synthetic: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class Summary:
    n: int
    p50: float | None
    p95: float | None
    mean: float | None
    min: float | None
    max: float | None


@dataclass(frozen=True, slots=True)
class CostGroup:
    #: Completed sessions (with a ledger or not).
    sessions: int
    mean_usd: float | None
    median_usd: float | None
    min_usd: float | None
    max_usd: float | None
    #: Mean list-price cost per completed session, by provider.
    by_provider_usd: dict[str, float]
    #: LLM requests with cache reads, of all LLM requests, and the sessions with at least one cache read.
    llm_requests: int
    cache_read_requests: int
    sessions_with_cache_read: int


@dataclass(frozen=True, slots=True)
class LatencyGroup:
    turns: int
    calls: int
    server_ms: Summary
    stt_ms: Summary
    llm_ttft_ms: Summary
    tts_ttfb_ms: Summary
    #: The browser's number, for the turns that have one.
    client_ms: Summary


@dataclass(frozen=True, slots=True)
class GroupData:
    sessions: int
    completed_sessions: int
    first_session_at: datetime | None
    last_session_at: datetime | None
    cost: CostGroup
    latency: LatencyGroup


@dataclass(frozen=True, slots=True)
class ReportData:
    options: ReportOptions
    real: GroupData
    synthetic: GroupData


# ---------------------------------------------------------------------------------------------------------------------
# Statistics


def percentile(sorted_ascending: Sequence[float], p: float) -> float | None:
    """Nearest-rank percentile of an ascending list: an observed value. None for an empty list."""
    n = len(sorted_ascending)
    if n == 0:
        return None
    rank = min(n, max(1, math.ceil(p / 100 * n)))
    return sorted_ascending[rank - 1]


def summarize(values: Sequence[float]) -> Summary:
    ordered = sorted(v for v in values if math.isfinite(v))
    n = len(ordered)
    return Summary(
        n=n,
        p50=percentile(ordered, 50),
        p95=percentile(ordered, 95),
        mean=sum(ordered) / n if n else None,
        min=ordered[0] if n else None,
        max=ordered[-1] if n else None,
    )


def median(values: Sequence[float]) -> float | None:
    """The usual median (the mean of the two middle values for an even count), for costs."""
    ordered = sorted(values)
    n = len(ordered)
    if n == 0:
        return None
    mid = n // 2
    return ordered[mid] if n % 2 == 1 else (ordered[mid - 1] + ordered[mid]) / 2


# ---------------------------------------------------------------------------------------------------------------------
# Collection


async def collect(db: Queryable, options: ReportOptions) -> ReportData:
    sessions = await db.fetch(
        """SELECT id::text AS id, status, outcome, created_at FROM sessions
            WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
            ORDER BY created_at""",
        options.from_,
        options.to,
    )
    real = [s for s in sessions if s["id"] not in options.synthetic]
    synthetic = [s for s in sessions if s["id"] in options.synthetic]
    return ReportData(options=options, real=await _group(db, real), synthetic=await _group(db, synthetic))


async def _group(db: Queryable, sessions: list[asyncpg.Record]) -> GroupData:
    ids = [s["id"] for s in sessions]
    completed = [s["id"] for s in sessions if s["status"] == "finalized" and s["outcome"] == "completed"]
    return GroupData(
        sessions=len(sessions),
        completed_sessions=len(completed),
        first_session_at=sessions[0]["created_at"] if sessions else None,
        last_session_at=sessions[-1]["created_at"] if sessions else None,
        cost=await _cost_group(db, completed),
        latency=await _latency_group(db, ids),
    )


async def _cost_group(db: Queryable, completed: list[str]) -> CostGroup:
    # Every completed session counts, with 0 when its ledger is empty (a session that cost nothing is still a session).
    per_session = await db.fetch(
        """SELECT s.id::text AS id, COALESCE(sum(u.cost_usd), 0)::text AS total
             FROM sessions s LEFT JOIN usage u ON u.session_id = s.id
            WHERE s.id = ANY($1::uuid[]) GROUP BY s.id""",
        completed,
    )
    totals = [float(r["total"]) for r in per_session]
    providers = await db.fetch(
        "SELECT provider, sum(cost_usd)::text AS total FROM usage WHERE session_id = ANY($1::uuid[]) "
        "GROUP BY provider ORDER BY provider",
        completed,
    )
    by_provider = {r["provider"]: float(r["total"]) / max(1, len(completed)) for r in providers}
    cache = await db.fetchrow(
        """SELECT count(*) FILTER (WHERE kind LIKE '%:requests') AS requests,
                  count(*) FILTER (WHERE kind LIKE '%:cachedInput' AND units > 0) AS cached,
                  count(DISTINCT session_id) FILTER (WHERE kind LIKE '%:cachedInput' AND units > 0) AS sessions
             FROM usage WHERE session_id = ANY($1::uuid[])""",
        completed,
    )
    assert cache is not None
    return CostGroup(
        sessions=len(totals),
        mean_usd=sum(totals) / len(totals) if totals else None,
        median_usd=median(totals),
        min_usd=min(totals) if totals else None,
        max_usd=max(totals) if totals else None,
        by_provider_usd=by_provider,
        llm_requests=int(cache["requests"]),
        cache_read_requests=int(cache["cached"]),
        sessions_with_cache_read=int(cache["sessions"]),
    )


async def _latency_group(db: Queryable, ids: list[str]) -> LatencyGroup:
    # Turns that follow a user utterance have a server number; a row with only a client number has no server side to
    # compare with (a client sample for a turn that never got a row) and is left out.
    rows = await db.fetch(
        """SELECT call_id, server_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms, client_ms FROM turn_metrics
            WHERE session_id = ANY($1::uuid[]) AND server_ms IS NOT NULL""",
        ids,
    )

    def column(name: str) -> list[float]:
        return [r[name] for r in rows if r[name] is not None]

    return LatencyGroup(
        turns=len(rows),
        calls=len({r["call_id"] for r in rows}),
        server_ms=summarize(column("server_ms")),
        stt_ms=summarize(column("stt_ms")),
        llm_ttft_ms=summarize(column("llm_ttft_ms")),
        tts_ttfb_ms=summarize(column("tts_ttfb_ms")),
        client_ms=summarize(column("client_ms")),
    )


# ---------------------------------------------------------------------------------------------------------------------
# Markdown


def _usd(v: float | None) -> str:
    return "n/a" if v is None else f"${v:.6f}"


def _ms(v: float | None) -> str:
    return "n/a" if v is None else f"{js_round(v)} ms"


def _day(d: datetime | None) -> str:
    return "n/a" if d is None else d.astimezone(UTC).strftime("%Y-%m-%d")


def _cell(text: str) -> str:
    return re.sub(r"[|\s]+", " ", text).strip()


def _latency_table(latency: LatencyGroup) -> str:
    def row(label: str, s: Summary) -> str:
        return f"| {label} | {s.n} | {_ms(s.p50)} | {_ms(s.p95)} | {_ms(s.mean)} | {_ms(s.min)} | {_ms(s.max)} |"

    return "\n".join(
        [
            "| Stage | n | p50 | p95 | mean | min | max |",
            "|---|---|---|---|---|---|---|",
            row("**Server: STT end-of-utterance → first audio frame sent**", latency.server_ms),
            row("STT: end-of-utterance event → turn starts (merge window)", latency.stt_ms),
            row("LLM: first token", latency.llm_ttft_ms),
            row("TTS: first text sent → first audio byte", latency.tts_ttfb_ms),
            row("Browser: mic speech end → first audio scheduled (secondary)", latency.client_ms),
        ]
    )


def gate_met(group: GroupData) -> bool:
    return group.cost.sessions >= GATE_COMPLETED_SESSIONS and group.latency.turns >= GATE_TURNS


def _group_section(title: str, g: GroupData, gate: bool) -> str:
    c, latency = g.cost, g.latency
    lines = [f"## {title}", ""]
    lines += [
        f"Sessions in the window: {g.sessions} ({_day(g.first_session_at)} to {_day(g.last_session_at)}); "
        f"completed: {g.completed_sessions}.",
        "",
        "### Cost per completed session (list-price equivalent; actual spend $0)",
        "",
    ]
    if c.sessions == 0:
        lines += ["No completed sessions.", ""]
    else:
        lines += [
            f"n = {c.sessions} completed sessions. Mean {_usd(c.mean_usd)}, median {_usd(c.median_usd)}, "
            f"min {_usd(c.min_usd)}, max {_usd(c.max_usd)}.",
            "",
            "| Provider | Mean per session |",
            "|---|---|",
        ]
        lines += [f"| {_cell(p)} | {_usd(v)} |" for p, v in c.by_provider_usd.items()]
        lines += [
            "",
            f"Prompt cache: {c.cache_read_requests} of {c.llm_requests} LLM requests read from the cache; "
            f"{c.sessions_with_cache_read} of {c.sessions} sessions had at least one cache read. "
            "(The first request of each session starts cold.)",
            "",
        ]
    lines += ["### Voice latency", "", f"n = {latency.turns} turns across {latency.calls} calls.", ""]
    lines += [_latency_table(latency), ""]
    if gate:
        sessions_ok = c.sessions >= GATE_COMPLETED_SESSIONS
        turns_ok = latency.turns >= GATE_TURNS
        lines += [
            "### P11 gate",
            "",
            f"- Cost: n ≥ {GATE_COMPLETED_SESSIONS} completed sessions: "
            f"**{'met' if sessions_ok else 'NOT met'}** (n = {c.sessions}).",
            f"- Latency: n ≥ {GATE_TURNS} turns: **{'met' if turns_ok else 'NOT met'}** (n = {latency.turns}).",
            "",
        ]
    return "\n".join(lines)


def render_markdown(data: ReportData) -> str:
    o = data.options
    window = f"{_day(o.from_) if o.from_ else 'the start'} to {_day(o.to) if o.to else 'now'}"
    echo = " Speaker echo can distort the browser-side number." if o.headphones == "no" else ""
    generated = o.now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{o.now.microsecond // 1000:03d}Z"
    return "\n".join(
        [
            "# Cost and latency measurements",
            "",
            f"Generated {generated} from the production database by `scripts/report.py`.",
            "",
            "## Conditions",
            "",
            f"- Window: sessions created {window}.",
            f"- Region: {_cell(o.region)}.",
            f"- Browsers: {_cell(o.browsers)}.",
            f"- Headphones: {o.headphones}.{echo}",
            f"- Real-user sessions: {data.real.sessions}. Synthetic runs (listed by the operator): "
            f"{data.synthetic.sessions}, reported separately below.",
            "",
            "## Method",
            "",
            "- **Cost:** the usage ledger, summed per completed session (`finalized` with outcome `completed`) at each "
            "provider's published paid list price (`app/metrics/prices.py`, each with its source and date). It is a "
            "list-price equivalent: the deployment runs on free tiers, so actual spend is $0. Neon and Render are $0 "
            "at this scale.",
            "- **Server latency (primary):** from the STT end-of-utterance event (Deepgram `speech_final`, with the "
            "endpointing delay of the STT settings) to the first TTS audio frame written to the socket, for each agent "
            "reply that follows a user utterance. Stage timings are listed beside it: the wait between that event and "
            "the turn starting (the merge window), the LLM's first token, and TTS's first byte.",
            "- **Browser latency (secondary):** the browser marks the end of speech when the mic level stays below a "
            "threshold for 300 ms, and the first agent audio chunk's scheduled start; it reports the difference. It "
            "hears the room, so it is noisy; it is listed apart and only for turns that have it.",
            "- **Percentiles:** nearest rank over the sample, so every p50 and p95 is a value that was observed.",
            "",
            _group_section("Real-user sessions", data.real, True),
            _group_section("Synthetic runs (reported separately)", data.synthetic, False),
        ]
    )


# ---------------------------------------------------------------------------------------------------------------------
# Command line


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="report.py", description="Cost and latency report (read-only).")
    parser.add_argument("--region", required=True, help="where the server and the user were (not in the database)")
    parser.add_argument("--browsers", required=True, help="browsers used (not in the database)")
    parser.add_argument("--headphones", required=True, choices=["yes", "no"])
    parser.add_argument("--from", dest="from_", type=_date, help="sessions created from this date/time (inclusive)")
    parser.add_argument("--to", type=_date, help="sessions created before this date/time (exclusive)")
    parser.add_argument("--synthetic-file", help="session ids (one per line, # comments) to report as synthetic")
    parser.add_argument("--out", help="write the report here instead of stdout")
    return parser


def _date(raw: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a date: {raw}") from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def read_synthetic_ids(text: str) -> frozenset[str]:
    ids: set[str] = set()
    for line in text.splitlines():
        session_id = re.sub(r"#.*", "", line).strip().lower()
        if not session_id:
            continue
        if not _UUID.match(session_id):
            raise ValueError(f"--synthetic-file: not a session id: {session_id[:40]}")
        ids.add(session_id)
    return frozenset(ids)


def parse_args(argv: Sequence[str], now: datetime) -> tuple[ReportOptions, str | None]:
    """Exits with status 2 (argparse) on bad arguments."""
    parser = _parser()
    ns = parser.parse_args(argv)
    for name in ("region", "browsers"):
        if not getattr(ns, name).strip():
            parser.error(f"--{name} is required (it isn't in the database; the report states it)")
    synthetic: frozenset[str] = frozenset()
    if ns.synthetic_file is not None:
        try:
            synthetic = read_synthetic_ids(Path(ns.synthetic_file).read_text(encoding="utf-8"))
        except OSError:
            parser.error(f"cannot read --synthetic-file {ns.synthetic_file}")
        except ValueError as err:
            parser.error(str(err))
    options = ReportOptions(
        region=ns.region,
        browsers=ns.browsers,
        headphones=ns.headphones,
        now=now,
        from_=ns.from_,
        to=ns.to,
        synthetic=synthetic,
    )
    return options, ns.out


async def run(database_url: str, options: ReportOptions) -> tuple[str, bool]:
    """The markdown report and whether the P11 gate is met. One read-only transaction; nothing is written."""
    dsn, ssl = connection_settings(database_url)
    conn: Any = await asyncpg.connect(dsn, ssl=ssl, timeout=15, statement_cache_size=0)
    try:
        async with conn.transaction(readonly=True):
            data = await collect(conn, options)
    finally:
        await conn.close()
    return render_markdown(data), gate_met(data.real)


def main(argv: Sequence[str] | None = None) -> int:
    options, out = parse_args(sys.argv[1:] if argv is None else argv, datetime.now(UTC))
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set (the Neon URL, in the shell environment only)", file=sys.stderr)
        return 2
    try:
        markdown, met = asyncio.run(run(url, options))
    except Exception as err:
        # The message only: a connection error can quote the URL.
        message = re.sub(r"postgres(ql)?://\S+", "<database url>", str(err))
        print(f"report failed: {message}", file=sys.stderr)
        return 1
    if out:
        Path(out).write_text(f"{markdown}\n", encoding="utf-8")
    else:
        sys.stdout.write(f"{markdown}\n")
    if not met:
        print(
            f"gate not met: need >= {GATE_COMPLETED_SESSIONS} completed real sessions and >= {GATE_TURNS} turns",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
