"""Session services for tests, with test-only command handlers that produce what later phases' handlers will (chat
messages, transcript lines, cards, calls, user activity). Production code never registers these.

Test commands are dicts (``{"type": "Test.Append", "n": 1}``); a handler reads them as attributes (snake_case).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from app.db.pool import Database
from app.db.repos.calls import end_call, insert_call
from app.domain.fields import FIELDS
from app.files.signing import create_file_url_signer
from app.protocol.enums import Role
from app.session.commands import Effects, EventDraft, Handler, TimerSettings
from app.session.services import SessionServices, create_session_services
from app.session.snapshot import Snapshot
from tests.helpers.fake import FAKE

TEST_TIMERS = TimerSettings(idle_timeout_ms=15 * 60_000, session_lifetime_ms=7 * 24 * 60 * 60_000)


class _Secret:
    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "[redacted]"


#: The file-link signer tests use (a fake secret; the origin is the test app's).
TEST_FILE_URL_SECRET = _Secret(FAKE["FILE_URL_SECRET"])
TEST_SIGNER = create_file_url_signer(secret=TEST_FILE_URL_SECRET, public_origin="https://repair.example.com")


class SilentLog:
    """A logger that drops everything (the TS tests' ``createLogger("silent")``)."""

    def __getattr__(self, name: str) -> Callable[..., None]:
        return lambda *args, **kwargs: None


class CapturedLog:
    """A logger that keeps what was logged: ``lines`` of ``(level, message, kwargs)``."""

    def __init__(self) -> None:
        self.lines: list[tuple[str, str, dict[str, Any]]] = []

    def __getattr__(self, level: str) -> Callable[..., None]:
        def write(message: str, **kwargs: Any) -> None:
            self.lines.append((level, message, kwargs))

        return write

    def errors(self) -> list[tuple[str, str, dict[str, Any]]]:
        return [line for line in self.lines if line[0] == "error"]


def _event(type_: str, channel: str = "system", **fields: Any) -> EventDraft:
    return EventDraft(type=type_, channel=channel, **fields)


def _append(_s: Snapshot, c: Any) -> Effects:
    """One plain event; ``n`` lands in the payload."""
    return Effects(events=[_event("test.event", payload={"n": c.n})])


def _say(_s: Snapshot, c: Any) -> Effects:
    """An agent (or user) chat message."""
    return Effects(
        events=[
            _event(
                "chat.message",
                "chat",
                chat_message={
                    "id": c.message_id,
                    "role": getattr(c, "role", None) or Role.AGENT,
                    "text": c.text,
                    "request_id": getattr(c, "request_id", None),
                },
            )
        ]
    )


def _transcript(s: Snapshot, c: Any) -> Effects:
    """A final call transcript line (the call row must exist)."""
    return Effects(
        events=[
            _event(
                "transcript.final",
                "call",
                transcript_line={
                    "id": c.line_id,
                    "call_id": c.call_id,
                    "role": getattr(c, "role", None) or Role.USER,
                    "text": c.text,
                    "started_at": s.now,
                },
            )
        ]
    )


def _open_card(_s: Snapshot, c: Any) -> Effects:
    """Opens the catalog card for ``field`` as ``request_id``."""
    return Effects(
        events=[
            _event(
                "input.requested",
                "chat",
                input_request={
                    "id": c.request_id,
                    "field": c.field,
                    "spec": FIELDS[c.field].card.to_dict(),
                    "status": "open",
                },
            )
        ]
    )


def _cancel_card(_s: Snapshot, c: Any) -> Effects:
    return Effects(
        events=[
            _event(
                "input.cancelled",
                "chat",
                payload={"requestId": c.request_id, "reason": "test"},
                input_request_update={"id": c.request_id, "status": "cancelled"},
            )
        ]
    )


def _reject(s: Snapshot, c: Any) -> Effects:
    """An invalid answer to an open card: the card stays open with one more attempt (what P4-T02 records)."""
    request = next((r for r in s.requests if r.id == c.request_id), None)
    attempt = (request.attempts if request else 0) + 1
    return Effects(
        events=[
            _event(
                "input.rejected",
                "chat",
                payload={"requestId": c.request_id, "attempt": attempt, "message": "That doesn't look right."},
                input_request_update={"id": c.request_id, "status": "open", "attempts": attempt},
            )
        ]
    )


def _activity(_s: Snapshot, c: Any) -> Effects:
    """Explicit user activity (moves the idle and expiry timers)."""
    return Effects(activity=True, events=[_event("test.activity", "chat")])


def _start_call(_s: Snapshot, c: Any) -> Effects:
    return Effects(session={"active_call_id": c.call_id}, events=[_event("call.started", "call")])


def _end_call(_s: Snapshot, c: Any) -> Effects:
    return Effects(session={"active_call_id": None}, events=[_event("call.ended", "call")])


def _candidate(_s: Snapshot, c: Any) -> Effects:
    """A candidate for ``field`` (raw value as given, validated elsewhere)."""
    source = getattr(c, "source", None) or "chat"
    return Effects(
        events=[
            _event(
                "field.candidate",
                source,
                candidate={
                    "field": c.field,
                    "source": source,
                    "raw": getattr(c, "raw", None),
                    "normalized": getattr(c, "normalized", None),
                    "status": getattr(c, "status", None) or "valid",
                    "evidence": getattr(c, "evidence", None),
                },
            )
        ]
    )


def _throw(_s: Snapshot, c: Any) -> Effects:
    raise RuntimeError("handler failed on purpose")


def _throw_after_write(_s: Snapshot, c: Any) -> Effects:
    # Two events, the second invalid (channel violates the CHECK): the first must roll back with it.
    return Effects(events=[_event("test.event", "system"), _event("test.event", "bogus")])


def _noop(_s: Snapshot, c: Any) -> Effects:
    return Effects(reply="nothing to do")


TEST_HANDLERS: dict[str, Handler] = {
    "Test.Append": _append,
    "Test.Say": _say,
    "Test.Transcript": _transcript,
    "Test.OpenCard": _open_card,
    "Test.CancelCard": _cancel_card,
    "Test.Reject": _reject,
    "Test.Activity": _activity,
    "Test.StartCall": _start_call,
    "Test.EndCall": _end_call,
    "Test.Candidate": _candidate,
    "Test.Throw": _throw,
    "Test.ThrowAfterWrite": _throw_after_write,
    "Test.Noop": _noop,
}


def test_services(
    db: Database,
    *,
    now: Callable[[], datetime] | None = None,
    timers: TimerSettings | None = None,
    planner: bool = False,
    sign_file_url: Callable[[str, datetime], str] | None = None,
    log: Any | None = None,
    failpoint: Callable[[str], Awaitable[None] | None] | None = None,
    auto_complete_on_idle: bool = True,
    on_outbox_queued: Callable[[], None] | None = None,
) -> SessionServices:
    """Services with the test-only handlers. The chat planner is off unless asked for: transport tests script their own
    cards, which the planner would otherwise join (P4 tests turn it on)."""
    services = create_session_services(
        pool=db.pool,
        log=log if log is not None else SilentLog(),
        timers=timers or TEST_TIMERS,
        now=now,
        planner=planner,
        sign_file_url=sign_file_url or TEST_SIGNER.sign,
        failpoint=failpoint,
        auto_complete_on_idle=auto_complete_on_idle,
        on_outbox_queued=on_outbox_queued,
    )
    for type_, handler in TEST_HANDLERS.items():
        services.processor.register(type_, handler)
    return services


test_services.__test__ = False  # type: ignore[attr-defined]  # not a pytest test


async def seed_call(db: Database, session_id: str, call_id: str, started_at: datetime | None = None) -> None:
    """A call row, so transcript lines can refer to it."""
    await insert_call(db.pool, id=call_id, session_id=session_id, started_at=started_at)


async def end_seeded_call(db: Database, call_id: str, ended_at: datetime | None = None) -> None:
    """Ends the call row (what EndCall writes); then dispatch Test.EndCall for the session side."""
    await end_call(db.pool, id=call_id, reason="test", ended_at=ended_at or datetime.now(UTC))
