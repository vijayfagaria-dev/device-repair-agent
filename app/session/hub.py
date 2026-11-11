"""In-process pub/sub per session (P3-T03, architecture section 2).

The command processor publishes each committed command here; chat sockets and the call engine subscribe. Only
committed state is ever published, so nothing acts on a change that might still roll back. Fan-out is per process: a
client on another instance replays on reconnect. Delivery is synchronous and in subscription order (publish never
awaits a listener), so a subscriber that subscribes first and then replays from the database never misses an event.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.db.repos.events import SessionEvent
from app.db.repos.sessions import Session


@dataclass(frozen=True, slots=True)
class SessionUpdate:
    """One committed command: its events in seq order, and the session row as it was committed.

    `record` is the record revision this command committed (P6-T01), if any: `{"revision": int, "payload": dict}`. It
    travels on the update rather than in an event payload, so the timeline never holds the record's signed file URLs
    (protocol.md section 8).
    """

    session_id: str
    events: Sequence[SessionEvent]
    session: Session
    record: Mapping[str, Any] | None = None


SessionListener = Callable[[SessionUpdate], None]


class SessionHub:
    def __init__(self, log: Any | None = None) -> None:
        self._listeners: dict[str, list[SessionListener]] = {}
        self._log = log

    def subscribe(self, session_id: str, listener: SessionListener) -> Callable[[], None]:
        """Adds a listener for one session; returns the unsubscribe function (idempotent)."""

        # Wrapped so the same function subscribed twice is two subscriptions, each removed by its own unsubscribe.
        def entry(update: SessionUpdate) -> None:
            listener(update)

        self._listeners.setdefault(session_id, []).append(entry)

        def unsubscribe() -> None:
            current = self._listeners.get(session_id)
            if current is None or entry not in current:
                return
            current.remove(entry)
            if not current:
                del self._listeners[session_id]

        return unsubscribe

    def publish(self, update: SessionUpdate) -> None:
        """Delivers the update to every listener of its session, synchronously and in subscription order. A listener
        that raises is logged and skipped: it never stops delivery to the others or reaches the publisher."""
        for listener in list(self._listeners.get(update.session_id, ())):
            try:
                listener(update)
            except Exception as err:
                if self._log is not None:
                    self._log.error("session listener failed", session_id=update.session_id, err=repr(err))

    def listener_count(self, session_id: str | None = None) -> int:
        """Listeners of one session, or of all sessions (for tests and leak checks)."""
        if session_id is not None:
            return len(self._listeners.get(session_id, ()))
        return sum(len(listeners) for listeners in self._listeners.values())
