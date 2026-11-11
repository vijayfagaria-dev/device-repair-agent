"""The command processor (D11, P3-T01): the single writer of session state.

``dispatch(session_id, command)``:
  per-session mutex -> one transaction: lock the session row FIRST (FOR UPDATE, so ordering also holds across two
  processes), load the snapshot, run the pure handler, write its effects (events + the rows tied to them, session
  row, timers) -> COMMIT -> publish the committed update to the hub -> release the mutex -> post-commit reactions
  (the chat planner's reconcile, P4-T01).

Handlers never touch the database or a provider: they get a snapshot and return effects, so they are fast and
deterministic, and a throwing handler leaves nothing behind (the transaction rolls back and nothing is published).

Publishing happens after COMMIT but just before the mutex is released (D11 says "after releasing"): publish is
synchronous and never awaits a listener, so it can't deadlock, and doing it inside the mutex guarantees that the hub
sees one session's commits in commit order. Reactions, which may dispatch more commands, run after release.

A command may register a ``prepare`` step (P6-T01): extra reads that only it needs (the session's cost for a record,
its uploads for a file answer), run in the same transaction after the snapshot, so the handler stays pure.

Commands are objects with a ``type`` attribute. Registered command classes (``register(..., command_class=...)``) are
frozen dataclasses; ``dispatch`` also takes a plain dict (snake_case or camelCase keys) and converts it. A dict for a
type registered without a class reaches its handler as a ``SimpleNamespace``.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from app.db.repos.calls import end_call, insert_call
from app.db.repos.chat_messages import insert_chat_message
from app.db.repos.events import SessionEvent, append_event
from app.db.repos.field_candidates import insert_field_candidate
from app.db.repos.input_requests import StoredInputRequest, insert_input_request, save_input_request
from app.db.repos.outbox import WEBHOOK_TARGET, insert_outbox
from app.db.repos.records import insert_record
from app.db.repos.sessions import Session, lock_session, save_session
from app.db.repos.timers import Timer, delete_timer, upsert_timer
from app.db.repos.transcript_lines import insert_transcript_line
from app.db.tx import Tx, transaction
from app.failpoints import failpoint

from .hub import SessionHub, SessionUpdate
from .mutex import KeyedMutex
from .snapshot import Snapshot, SnapshotExtras, load_snapshot

_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(key: str) -> str:
    return _CAMEL.sub("_", key).lower()


@dataclass(slots=True)
class EventDraft:
    """One event to append, with the row it introduces (if any). The row's data is copied into the event payload.

    The nested dicts use snake_case keys (they are Python-side drafts; the stored payloads keep the wire's camelCase):
    - ``chat_message``: id, role, text, request_id?
    - ``transcript_line``: id, call_id, role, text, interrupted?, started_at
    - ``input_request`` (a new card): id, field, spec, status
    - ``input_request_update`` (status/attempts change on an existing card): id, status, attempts?
    - ``candidate``: field, source, raw, status, normalized?, error?, user_confirmed?, evidence?
    """

    type: str
    channel: str
    payload: dict[str, Any] | None = None
    chat_message: dict[str, Any] | None = None
    transcript_line: dict[str, Any] | None = None
    input_request: dict[str, Any] | None = None
    input_request_update: dict[str, Any] | None = None
    candidate: dict[str, Any] | None = None


#: Session columns a handler may change (a dict with any of: status, outcome, current_revision, active_call_id,
#: review_flags, language). `version`, `last_activity_at` and `open_request_id` are maintained by the processor.
SessionPatch = dict[str, Any]


@dataclass(slots=True)
class TimerEffects:
    #: (kind, due_at) pairs to set.
    set: list[tuple[str, datetime]] = field(default_factory=list)
    clear: list[str] = field(default_factory=list)


@dataclass(slots=True)
class CallEffect:
    """A call starting or ending (P5-T02): the ``calls`` row, written before the events."""

    start: dict[str, Any] | None = None  # id, started_at
    end: dict[str, Any] | None = None  # id, reason, ended_at


@dataclass(slots=True)
class RecordEffect:
    """A new record revision (P6-T01), inserted in this transaction together with its outbox row (P7-T02)."""

    revision: int
    outcome: Any
    payload: dict[str, Any]
    content_hash: str


@dataclass(slots=True)
class Effects:
    """What a handler decided. Everything is optional: an empty result is a no-op that writes and publishes nothing."""

    events: list[EventDraft] = field(default_factory=list)
    session: SessionPatch | None = None
    timers: TimerEffects = field(default_factory=TimerEffects)
    #: Explicit user activity (P3-T05): moves ``last_activity_at``, the idle timer and the session-expiry timer.
    activity: bool = False
    call: CallEffect | None = None
    record: RecordEffect | None = None
    #: Returned to the dispatcher; never persisted.
    reply: Any = None


Handler = Callable[[Snapshot, Any], Effects]
Prepare = Callable[[Tx, Snapshot, Any], Awaitable[SnapshotExtras]]

#: A post-commit reaction (D11): runs after every command and on demand; may dispatch more commands. ``command`` is
#: the command it follows (None on demand: chat connect, boot), ``update`` what that command committed (None for a no-op).
Reaction = Callable[[str, SessionUpdate | None, Any], Awaitable[None] | None]


@dataclass(frozen=True, slots=True)
class TimerSettings:
    #: IDLE_TIMEOUT_SECONDS (D16): no call and no user activity for this long -> the idle timer fires.
    idle_timeout_ms: float
    #: SESSION_LIFETIME_SECONDS (PD3a): last activity + this -> the session-expiry timer fires.
    session_lifetime_ms: float


@dataclass(frozen=True, slots=True)
class DispatchResult:
    reply: Any
    #: What was committed and published; None when the handler decided on a no-op.
    update: SessionUpdate | None


class UnsupportedCommandError(Exception):
    def __init__(self, command_type: str) -> None:
        super().__init__(f'no handler for command "{command_type}"')
        self.name = "UnsupportedCommandError"
        self.command_type = command_type


class SessionNotFoundError(Exception):
    def __init__(self, session_id: str) -> None:
        super().__init__("session not found")
        self.name = "SessionNotFoundError"
        self.session_id = session_id


def command_type(command: Any) -> str:
    return str(command["type"] if isinstance(command, Mapping) else command.type)


def command_from_dict(cls: type, data: Mapping[str, Any]) -> Any:
    """Builds a command dataclass from a dict whose keys are the field names in snake_case or camelCase."""
    values = {_snake(key): value for key, value in data.items() if key != "type"}
    names = {f.name for f in dataclasses.fields(cls)}
    unknown = set(values) - names
    if unknown:
        raise TypeError(f"{cls.__name__}: unexpected field(s) {sorted(unknown)}")
    return cls(**values)


@dataclass(slots=True)
class _Registered:
    handler: Handler
    prepare: Prepare | None
    command_class: type | None


@dataclass(slots=True)
class _Executed:
    reply: Any
    update: SessionUpdate | None
    scheduled: list[datetime]
    queued_delivery: bool


class CommandProcessor:
    def __init__(
        self,
        *,
        pool: Any,
        hub: SessionHub,
        log: Any,
        timers: TimerSettings,
        now: Callable[[], datetime] | None = None,
        on_timer_scheduled: Callable[[datetime], None] | None = None,
        slow_handler_ms: float = 5,
        on_outbox_queued: Callable[[], None] | None = None,
        failpoint: Callable[[str], Awaitable[None] | None] | None = None,
    ) -> None:
        """`on_timer_scheduled`: told about every timer due time a command committed, so the sweeper can wake earlier.
        `slow_handler_ms`: handlers slower than this are logged. `on_outbox_queued`: told after a command committed a
        record, so the outbox worker can deliver it at once (P7-T03). `failpoint`: called inside the transaction after
        every write and before COMMIT, with the name ``"beforeCommit"``; raising aborts the command with nothing written
        (crash tests; production never sets it)."""
        self._pool = pool
        self._hub = hub
        self._log = log
        self._timers = timers
        self._now = now or (lambda: datetime.now(UTC))
        self._slow_handler_ms = slow_handler_ms
        self._mutex = KeyedMutex()
        self._handlers: dict[str, _Registered] = {}
        self._reactions: list[Reaction] = []
        self.on_timer_scheduled = on_timer_scheduled
        self.on_outbox_queued = on_outbox_queued
        self._inflight = 0
        self._failpoint = failpoint

    def register(
        self,
        type: str,
        handler: Handler,
        *,
        prepare: Prepare | None = None,
        command_class: type | None = None,
    ) -> CommandProcessor:
        if type in self._handlers:
            raise ValueError(f'handler for "{type}" already registered')
        self._handlers[type] = _Registered(handler, prepare, command_class)
        return self

    def add_reaction(self, reaction: Reaction) -> CommandProcessor:
        """Adds a post-commit reaction (the chat planner's reconcile registers here)."""
        self._reactions.append(reaction)
        return self

    def timer_scheduled(self, due_at: datetime) -> None:
        """Reports a timer committed outside a command (a new session's noCallStart, ensure_session) to the same listener."""
        if self.on_timer_scheduled is not None:
            self.on_timer_scheduled(due_at)

    @property
    def busy_sessions(self) -> int:
        """Commands queued or running in this process (for leak checks in tests)."""
        return self._mutex.size

    async def drain(self, timeout_ms: float) -> bool:
        """Waits until every dispatch in this process has finished, reactions included (shutdown, P8-T02). False on timeout."""
        deadline = time.monotonic() + timeout_ms / 1000
        while self._inflight > 0:
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.01)
        return True

    async def dispatch(self, session_id: str, command: Any) -> DispatchResult:
        self._inflight += 1
        try:
            return await self._dispatch(session_id, command)
        finally:
            self._inflight -= 1

    async def _dispatch(self, session_id: str, raw_command: Any) -> DispatchResult:
        ctype = command_type(raw_command)
        registered = self._handlers.get(ctype)
        if registered is None:
            raise UnsupportedCommandError(ctype)
        command = self._coerce(registered, raw_command)

        async def locked() -> _Executed:
            async with transaction(self._pool) as tx:
                result = await self._execute(tx, session_id, command, ctype, registered)
            # Chaos tests (P8-T03): die right after COMMIT, before anything that follows a commit has run.
            if result.queued_delivery:
                failpoint("finalize.afterCommit")
            failpoint(f"commit.after.{ctype}")
            if result.update is not None:
                self._hub.publish(result.update)
            return result

        executed = await self._mutex.run(session_id, locked)
        for due_at in executed.scheduled:
            if self.on_timer_scheduled is not None:
                self.on_timer_scheduled(due_at)
        if executed.queued_delivery and self.on_outbox_queued is not None:
            self.on_outbox_queued()
        await self.react(session_id, executed.update, command)
        return DispatchResult(reply=executed.reply, update=executed.update)

    @staticmethod
    def _coerce(registered: _Registered, command: Any) -> Any:
        cls = registered.command_class
        if isinstance(command, Mapping):
            if cls is not None:
                return command_from_dict(cls, command)
            return SimpleNamespace(**{_snake(k): v for k, v in command.items()})
        return command

    async def react(self, session_id: str, update: SessionUpdate | None = None, command: Any = None) -> None:
        """Runs the post-commit reactions. Called after every command, and on demand: on chat connect (protocol.md
        section 4 step 5) and at boot (P8-T01). A failing reaction is logged; the command it followed stays committed."""
        for reaction in self._reactions:
            try:
                outcome = reaction(session_id, update, command)
                if inspect.isawaitable(outcome):
                    await outcome
            except Exception as err:
                self._log.error("post-commit reaction failed", session_id=session_id, err=repr(err))

    async def _execute(self, tx: Tx, session_id: str, command: Any, ctype: str, registered: _Registered) -> _Executed:
        session = await lock_session(tx, session_id)
        if session is None:
            raise SessionNotFoundError(session_id)
        now = self._now()
        loaded = await load_snapshot(tx, session, now)
        snapshot = loaded
        if registered.prepare is not None:
            extras = await registered.prepare(tx, loaded, command)
            snapshot = dataclasses.replace(loaded, **extras)

        started = time.perf_counter()
        effects = registered.handler(snapshot, command)
        elapsed_ms = (time.perf_counter() - started) * 1000
        if elapsed_ms > self._slow_handler_ms:
            self._log.warning("slow command handler", session_id=session_id, command=ctype, elapsed_ms=elapsed_ms)

        drafts = effects.events
        after = dataclasses.replace(session, **effects.session) if effects.session is not None else session
        timer_plan = plan_timers(snapshot, after, effects, self._timers)
        existing_by_kind = {timer.kind: timer for timer in snapshot.timers}

        def needs_write(kind: str, due_at: datetime | None) -> bool:
            existing = existing_by_kind.get(kind)
            return existing is not None if due_at is None else (existing is None or existing.due_at != due_at)

        timer_writes = [(kind, due_at) for kind, due_at in timer_plan.items() if needs_write(kind, due_at)]
        if (
            not drafts
            and effects.session is None
            and not effects.activity
            and effects.record is None
            and effects.call is None
            and not timer_writes
        ):
            return _Executed(effects.reply, None, [], False)

        if effects.call is not None and effects.call.start is not None:
            start = effects.call.start
            await insert_call(tx, id=start["id"], session_id=session_id, started_at=start["started_at"])
        if effects.call is not None and effects.call.end is not None:
            end = effects.call.end
            await end_call(tx, id=end["id"], reason=end["reason"], ended_at=end["ended_at"])

        requests = {request.id: request for request in snapshot.requests}
        events: list[SessionEvent] = []
        for index, draft in enumerate(drafts):
            events.append(await write_event(tx, session_id, snapshot.last_seq + 1 + index, draft, requests))

        if effects.record is not None:
            record = effects.record
            await insert_record(
                tx,
                session_id=session_id,
                revision=record.revision,
                outcome=record.outcome,
                payload=record.payload,
                content_hash=record.content_hash,
            )
            # The delivery is queued in the record's own transaction: a crash before COMMIT leaves neither, after it
            # both (D17), and a restart finds the row and delivers (P8-T01).
            await insert_outbox(tx, session_id=session_id, revision=record.revision, target=WEBHOOK_TARGET)

        # At most one card is open per session; the partial unique index input_requests_one_open_idx enforces it, so a
        # second open card has already failed the command (and rolled it back) by here.
        open_request = next((request for request in requests.values() if request.status == "open"), None)
        saved = await save_session(
            tx,
            dataclasses.replace(
                after,
                open_request_id=open_request.id if open_request else None,
                last_activity_at=now if effects.activity else session.last_activity_at,
                version=session.version + 1,
            ),
        )
        if saved is None:
            raise SessionNotFoundError(session_id)

        scheduled: list[datetime] = []
        for kind, due_at in timer_writes:
            if due_at is None:
                await delete_timer(tx, session_id, kind)
            else:
                await upsert_timer(tx, Timer(session_id=session_id, kind=kind, due_at=due_at))
                scheduled.append(due_at)
        update = SessionUpdate(
            session_id=session_id,
            events=events,
            session=saved,
            record={"revision": effects.record.revision, "payload": effects.record.payload} if effects.record else None,
        )
        if effects.record is not None:
            failpoint("finalize.beforeCommit")
        if self._failpoint is not None:
            outcome = self._failpoint("beforeCommit")
            if inspect.isawaitable(outcome):
                await outcome
        return _Executed(effects.reply, update, scheduled, effects.record is not None)


def plan_timers(
    snapshot: Snapshot, after: Session, effects: Effects, settings: TimerSettings
) -> dict[str, datetime | None]:
    """The timers the command leaves behind (P3-T05): the handler's own changes, then the activity rules.

    - User activity moves ``sessionExpiry`` to now + lifetime (unless the session is closed).
    - ``idle`` exists only while the session is active with no call: a call removes it, and activity or the end of a
      call (re-)arms it to now + idle timeout.
    """
    plan: dict[str, datetime | None] = {}
    for kind in effects.timers.clear:
        plan[kind] = None
    for kind, due_at in effects.timers.set:
        plan[kind] = due_at
    now = snapshot.now
    if effects.activity and after.status != "closed":
        plan["sessionExpiry"] = now + timedelta(milliseconds=settings.session_lifetime_ms)
    idle_applies = after.status == "active" and after.active_call_id is None
    call_ended = snapshot.session.active_call_id is not None and after.active_call_id is None
    if not idle_applies:
        plan["idle"] = None
    elif effects.activity or call_ended:
        plan["idle"] = now + timedelta(milliseconds=settings.idle_timeout_ms)
    return plan


async def write_event(
    tx: Tx, session_id: str, seq: int, draft: EventDraft, requests: dict[str, StoredInputRequest]
) -> SessionEvent:
    """Appends one event at ``seq`` and writes the row it introduces; the row's data goes into the payload too."""
    payload: dict[str, Any] = dict(draft.payload or {})
    if draft.chat_message is not None:
        message = draft.chat_message
        request_id = message.get("request_id")
        await insert_chat_message(
            tx,
            id=message["id"],
            session_id=session_id,
            event_seq=seq,
            role=message["role"],
            text=message["text"],
            request_id=request_id,
        )
        payload["message"] = {
            "id": message["id"],
            "role": message["role"],
            "text": message["text"],
            "requestId": request_id,
        }
    if draft.transcript_line is not None:
        line = draft.transcript_line
        interrupted = bool(line.get("interrupted", False))
        await insert_transcript_line(
            tx,
            id=line["id"],
            session_id=session_id,
            call_id=line["call_id"],
            event_seq=seq,
            role=line["role"],
            text=line["text"],
            interrupted=interrupted,
            started_at=line["started_at"],
        )
        payload["line"] = {
            "id": line["id"],
            "callId": line["call_id"],
            "role": line["role"],
            "text": line["text"],
            "interrupted": interrupted,
        }
    if draft.input_request is not None:
        stored = await insert_input_request(tx, session_id=session_id, **draft.input_request)
        requests[stored.id] = stored
        payload["request"] = {
            "id": stored.id,
            "field": stored.field,
            "status": stored.status,
            "attempts": stored.attempts,
            "spec": stored.spec,
        }
    if draft.input_request_update is not None:
        update = draft.input_request_update
        current = requests.get(update["id"])
        if current is None:
            raise RuntimeError(f"no input request {update['id']} in this session")
        attempts = update.get("attempts")
        saved = await save_input_request(
            tx,
            session_id=session_id,
            id=update["id"],
            status=update["status"],
            attempts=current.attempts if attempts is None else attempts,
        )
        if saved is None:
            raise RuntimeError(f"input request {update['id']} vanished")
        requests[update["id"]] = saved
        payload["request"] = {
            "id": update["id"],
            "field": saved.field,
            "status": saved.status,
            "attempts": saved.attempts,
            "spec": saved.spec,
        }
    if draft.candidate is not None:
        candidate = draft.candidate
        await insert_field_candidate(tx, session_id=session_id, event_seq=seq, **candidate)
        # Evidence (the LLM's quote of the transcript) stays in its row; the timeline shows the decision, not the quote.
        payload["candidate"] = {
            "field": candidate["field"],
            "source": candidate["source"],
            "status": candidate["status"],
            "raw": candidate["raw"],
            "normalized": candidate.get("normalized"),
            "error": candidate.get("error"),
            "userConfirmed": candidate.get("user_confirmed") or False,
        }
    return await append_event(
        tx, session_id=session_id, seq=seq, type=draft.type, channel=draft.channel, payload=payload
    )


__all__ = [
    "CallEffect",
    "CommandProcessor",
    "DispatchResult",
    "Effects",
    "EventDraft",
    "Handler",
    "Prepare",
    "Reaction",
    "RecordEffect",
    "SessionNotFoundError",
    "SessionPatch",
    "TimerEffects",
    "TimerSettings",
    "UnsupportedCommandError",
    "command_from_dict",
    "command_type",
    "plan_timers",
    "write_event",
]
