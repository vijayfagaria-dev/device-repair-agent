"""Reopening a finalized session (P7-T05, D16 "after an outcome", PD3a).

Explicit user activity (a card submission, a new call) on a ``finalized`` session reopens it: the command runs as if
the session were active, and ``session.reopened`` is its first event, so the whole change (the reopen and what the
user did) commits or fails together. The next finalization then produces revision n+1 if its content changed.
A socket reconnect is not activity and never gets here; ``closed`` sessions never reopen; after an opt-out the user
first confirms "Resume your claim?" (``can_reopen`` in domain/outcome.py holds those rules).
"""

from __future__ import annotations

import dataclasses
from dataclasses import replace

from app.domain.outcome import Activity, Lifecycle, can_reopen
from app.session.commands import Effects, EventDraft
from app.session.snapshot import Snapshot


def reopened_snapshot(snapshot: Snapshot, activity: Activity) -> Snapshot | None:
    """The snapshot as it is once the session is active again, or None when this activity can't reopen it."""
    session = snapshot.session
    if not can_reopen(Lifecycle(status=session.status, outcome=session.outcome), activity).reopen:  # type: ignore[arg-type]
        return None
    return replace(snapshot, session=dataclasses.replace(session, status="active"))


def with_reopen(before: Snapshot, activity: Activity, effects: Effects) -> Effects:
    """The effects of a handler that ran against ``reopened_snapshot(before, ...)``, with the reopen added.

    A handler that did nothing (a stale answer) leaves the session finalized: only a change the user caused reopens it.
    The handler's own session patch wins (answering "Yes" on "Submit claim?" reopens and finalizes again in one command).
    """
    changed = (
        len(effects.events) > 0 or effects.session is not None or effects.record is not None or effects.call is not None
    )
    if not changed:
        return effects
    reopened = EventDraft(
        type="session.reopened",
        channel="system",
        payload={
            "activity": activity,
            "previousOutcome": before.session.outcome,
            "revision": before.session.current_revision,
        },
    )
    return replace(
        effects,
        events=[reopened, *effects.events],
        session={"status": "active", **(effects.session or {})},
        activity=True,
    )
