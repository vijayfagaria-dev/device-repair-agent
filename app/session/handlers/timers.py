"""TimerFired (P3-T05): the sweeper's command for a due persisted timer.

Idempotent: it re-checks the timer under the session lock, so a timer that was moved, cleared or already fired (by
another sweeper) is a no-op. What a fired timer leads to (P7-T01, P7-T05):
- idle: the user stopped engaging -> finalize with the ``idleTimeout`` trigger (D16): ``partial``, or ``completed``
  (AUTO_COMPLETE_ON_IDLE) or ``needsReview`` by the decision table. The finalization rides in the same command.
- sessionExpiry (PD3a): 7 days after the last activity. A finalization still pending runs first, so every session gets a
  record, then the session is ``closed``: it can't be reopened and no revision follows.
Everything else is recorded as a ``timer.fired`` event and the timer removed.
noCallStart (PD10, P4-T04): the page was opened but no call started within the deadline, so the chat takes over:
``chat.started`` switches the planner to chat mode, which then opens the first card.

Reply: ``{"fired": True, "finalized"?: {"revision", "outcome", "unchanged"?}, "closed"?: True}`` or
``{"fired": False, "reason": "notDue"|"callActive"|"notActive"|"notNeeded"}``.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar

from app.agent.chat_planner import cancel_draft
from app.agent.chat_templates import CHAT_START_MESSAGE
from app.db.tx import Tx
from app.protocol.enums import Role
from app.session.commands import Effects, EventDraft, Handler, TimerEffects
from app.session.ids import new_message_id
from app.session.snapshot import Snapshot, SnapshotExtras
from app.session.timeutil import iso_ms

from .finalize import FinalizeDeps, FinalizeOptions, finalize_effects, finalize_extras


@dataclass(frozen=True, slots=True)
class TimerFired:
    type: ClassVar[str] = "TimerFired"
    kind: str
    #: The due time the sweeper saw (for the log); the stored one is what counts.
    due_at: datetime


async def timer_fired_prepare(tx: Tx, snapshot: Snapshot, command: TimerFired) -> SnapshotExtras:
    """The reads a finalizing timer needs (cost, latest revision); the others read nothing extra."""
    if command.kind in ("idle", "sessionExpiry") and snapshot.session.status == "active":
        return await finalize_extras(tx, snapshot.session.id)
    return {}


def _fired_event(kind: str, due_at: datetime) -> EventDraft:
    return EventDraft(type="timer.fired", channel="system", payload={"kind": kind, "dueAt": iso_ms(due_at)})


def _cancel_pending(snapshot: Snapshot, already_cancelled: Collection[str]) -> list[EventDraft]:
    """Cards still waiting for an answer, cancelled with the reason (a closed session takes no answers)."""
    return [
        cancel_draft(request.id, "session closed")
        for request in snapshot.requests
        if request.status in ("open", "queued") and request.id not in already_cancelled
    ]


def timer_fired_handler(deps: FinalizeDeps) -> Handler:
    def handle(snapshot: Snapshot, command: TimerFired) -> Effects:
        kind = command.kind
        timer = next((t for t in snapshot.timers if t.kind == kind), None)
        # Gone (fired elsewhere or cleared) or moved later by activity since the sweeper read it.
        if timer is None or timer.due_at > snapshot.now:
            return Effects(reply={"fired": False, "reason": "notDue"})
        if kind == "idle":
            # Never during a call (the call's end re-arms it), and only while the session is active.
            if snapshot.session.active_call_id is not None:
                return Effects(timers=TimerEffects(clear=["idle"]), reply={"fired": False, "reason": "callActive"})
            if snapshot.session.status != "active":
                return Effects(timers=TimerEffects(clear=["idle"]), reply={"fired": False, "reason": "notActive"})
            return _finalizing(snapshot, timer.due_at, "idle", deps, close=False)
        if kind == "sessionExpiry":
            return _expire(snapshot, timer.due_at, deps)
        if kind == "noCallStart":
            # A call happened (or is on), the chat already started, or the session is done: nothing to switch.
            if snapshot.session.status != "active" or len(snapshot.calls) > 0 or snapshot.history.chat_started:
                return Effects(
                    timers=TimerEffects(clear=["noCallStart"]), reply={"fired": False, "reason": "notNeeded"}
                )
            return Effects(
                timers=TimerEffects(clear=["noCallStart"]),
                events=[
                    _fired_event(kind, timer.due_at),
                    EventDraft(type="chat.started", channel="chat", payload={"reason": "noCallStart"}),
                    EventDraft(
                        type="chat.message",
                        channel="chat",
                        chat_message={"id": new_message_id(), "role": Role.AGENT, "text": CHAT_START_MESSAGE},
                    ),
                ],
                reply={"fired": True},
            )
        return Effects(
            timers=TimerEffects(clear=[kind]), events=[_fired_event(kind, timer.due_at)], reply={"fired": True}
        )

    return handle


def _finalizing(snapshot: Snapshot, due_at: datetime, kind: str, deps: FinalizeDeps, *, close: bool) -> Effects:
    """The idle timer, or the expiry timer on a session that is still active: finalize (and, for expiry, close)."""
    fired = _fired_event(kind, due_at)
    result = finalize_effects(snapshot, FinalizeOptions(trigger="idleTimeout"), deps)
    # idleTimeout always finalizes (decide_outcome); an active session that somehow can't just loses the timer.
    if not result.finalized or result.effects is None:
        return Effects(timers=TimerEffects(clear=[kind]), events=[fired], reply={"fired": True})
    e = result.effects
    cancelled = {
        d.input_request_update["id"]
        for d in e.events
        if d.input_request_update is not None and d.input_request_update.get("status") == "cancelled"
    }
    closing: list[EventDraft] = []
    if close:
        closing = [
            EventDraft(type="session.closed", channel="system", payload={"revision": result.revision}),
            *_cancel_pending(snapshot, cancelled),
        ]
    finalized = {"revision": result.revision, "outcome": result.outcome}
    if result.unchanged:
        finalized["unchanged"] = True
    reply: dict = {"fired": True, "finalized": finalized}
    if close:
        reply["closed"] = True
    return Effects(
        events=[fired, *e.events, *closing],
        session={**e.session, "status": "closed"} if close else e.session,
        record=e.record,
        timers=TimerEffects(clear=[*e.timers.clear, kind, *(["idle", "noCallStart"] if close else [])]),
        reply=reply,
    )


def _expire(snapshot: Snapshot, due_at: datetime, deps: FinalizeDeps) -> Effects:
    """PD3a: a pending finalization first, then ``closed``: read-only forever, no new revision."""
    status = snapshot.session.status
    if status == "closed":
        return Effects(timers=TimerEffects(clear=["sessionExpiry"]), reply={"fired": False, "reason": "notActive"})
    if status == "active":
        return _finalizing(snapshot, due_at, "sessionExpiry", deps, close=True)
    return Effects(
        timers=TimerEffects(clear=["sessionExpiry", "idle", "noCallStart"]),
        session={"status": "closed"},
        events=[
            _fired_event("sessionExpiry", due_at),
            EventDraft(
                type="session.closed", channel="system", payload={"revision": snapshot.session.current_revision}
            ),
            *_cancel_pending(snapshot, set()),
        ],
        reply={"fired": True, "closed": True},
    )
