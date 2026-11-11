"""WS /chat (P3-T04; protocol.md sections 3.3, 4 and 7).

Per connection: handshake (Origin, session id, lazy creation; handshake.py) -> subscribe to the hub and buffer ->
replay from the database (history, open card, latest record, sessionState, syncDone) -> flush the buffer (events after
the replay's last_seq, minus anything already sent) -> live stream. Then the post-commit reactions run once (the
planner's reconcile, P4-T01). A connect is not user activity: it moves no timer and reopens nothing; the only thing it
can write is a card the planner finds missing (protocol.md section 4 step 5).

Inbound messages are validated (app.protocol.parse_chat_client_message) and dispatched as commands; anything invalid or
unknown is logged and dropped, and the socket stays open.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from app.db.repos.calls import get_call
from app.db.repos.turn_metrics import upsert_turn_metric
from app.metrics.latency import call_id_of_turn
from app.protocol.schemas import parse_chat_client_message
from app.protocol.session import CloseCode, CloseReason
from app.session.commands import CommandProcessor, UnsupportedCommandError
from app.session.handlers.chat_input import STALE_REQUEST_MESSAGE, OptOutRequested, SubmitChatInput
from app.session.hub import SessionHub, SessionUpdate

from .chat_projection import (
    ChatWire,
    input_error_wire,
    input_request_wire,
    same_session_state,
    session_state_wire,
    state_version,
    sync_done_wire,
    to_chat_messages,
)
from .chat_replay import load_replay
from .closing import close_with_notice
from .handshake import SocketDeps, accept_session_socket
from .socket import ManagedSocket

#: A client that stops reading while messages pile up is dropped rather than buffered without bound; it reconnects and
#: replays, which is the recovery path anyway.
MAX_CHAT_BUFFERED_BYTES = 1024 * 1024
#: protocol.md section 7: clientMetric at most once per second per socket.
CLIENT_METRIC_INTERVAL_MS = 1000
#: Answers and Stop taps per socket per window (P4-T02; the P3 audit's deferred inbound limit). A person answers a card
#: every few seconds at most; beyond this a client is looping, and each answer is a database transaction.
MAX_COMMANDS_PER_WINDOW = 20
COMMAND_WINDOW_MS = 10_000
TOO_FAST_MESSAGE = "You're sending answers too quickly. Please wait a moment and try again."
ANSWER_NOT_SAVED_MESSAGE = "Your answer couldn't be saved. Please try again."
#: protocol.md section 7: /chat messages are at most 64 KB.
MAX_CHAT_MESSAGE_BYTES = 64 * 1024


@dataclass(slots=True)
class ChatSocketDeps:
    socket: SocketDeps
    hub: SessionHub
    processor: CommandProcessor
    #: `sessionState.voiceAvailable`: false while the quota guard would refuse a call (P10-T03). Default: true.
    voice_available: Callable[[], bool] | None = None


def _now_ms() -> float:
    return time.monotonic() * 1000


async def chat_socket(socket: ManagedSocket, deps: ChatSocketDeps) -> None:
    """The /chat endpoint body, on an accepted socket."""
    accepted = await accept_session_socket(socket, deps.socket, "chat", "/chat")
    if accepted is None:
        return
    connection = ChatConnection(socket, accepted.session.id, accepted.log, deps)
    await connection.start()
    if socket.is_open:
        socket.on_message(connection.receive)


class ChatConnection:
    def __init__(self, socket: ManagedSocket, session_id: str, log: Any, deps: ChatSocketDeps) -> None:
        self._socket = socket
        self._session_id = session_id
        self._log = log
        self._deps = deps
        #: Ids of the messages sent on this socket: replay and buffered live updates may overlap.
        self._sent: set[str] = set()
        self._buffer: list[SessionUpdate] = []
        self._live = False
        self._last_seq = 0
        self._state: ChatWire | None = None
        self._last_metric_at = -math.inf
        self._window_start = -math.inf
        self._window_count = 0
        self._tasks: set[asyncio.Task[Any]] = set()

    def _spawn(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def start(self) -> None:
        # Subscribe first, so nothing committed while the replay is read is lost (protocol.md section 4 step 2).
        def on_update(update: SessionUpdate) -> None:
            if self._live:
                self._deliver(update)
            else:
                self._buffer.append(update)

        unsubscribe = self._deps.hub.subscribe(self._session_id, on_update)
        self._socket.on_close(lambda _code: unsubscribe())

        try:
            replay = await load_replay(self._deps.socket.pool, self._session_id)
        except Exception as err:
            self._log.error("chat replay failed", code=getattr(err, "sqlstate", None), message=str(err))
            close_with_notice(self._socket, CloseCode.SERVER_ERROR, CloseReason.SERVER_ERROR)
            return
        if not self._socket.is_open:
            return

        self._last_seq = replay.last_seq
        for message in replay.history:
            self._send_once(message)
        if replay.open_request is not None:
            self._send_once(replay.open_request)
        if replay.record is not None:
            self._send_once(replay.record)
        self._send_state(replay.state)
        self._send(sync_done_wire(replay.last_seq))

        self._live = True
        buffered, self._buffer = self._buffer, []
        for update in buffered:
            self._deliver(update)
        self._log.debug("chat replay sent", last_seq=replay.last_seq, sent=len(self._sent))

        # Step 5: make the session's chat state what it should be (the planner, P4-T01). Never fails the connection.
        self._spawn(self._deps.processor.react(self._session_id))

    def _deliver(self, update: SessionUpdate) -> None:
        """One live (or buffered) committed update: its chat-visible events newer than the replay, then the state."""
        for event in update.events:
            if event.seq <= self._last_seq:
                continue  # already in the replay
            # A card brought back after the Stop flow paused it (P4-T05) reuses its id: this socket may have sent it
            # before, and must send it again (the event itself is new, so the seq filter above already deduplicates it).
            again = event.type == "input.resumed"
            # session.finalized carries its record (P6-T01): it lands after the cards the finalization closed and before
            # the closing message, which is a later event.
            for message in to_chat_messages(event, update.record):
                self._send_once(message, again)
        self._send_state(session_state_wire(update.session))

    def _within_budget(self) -> bool:
        """True while this socket is within its command budget (fixed window)."""
        now = _now_ms()
        if now - self._window_start >= COMMAND_WINDOW_MS:
            self._window_start = now
            self._window_count = 0
        self._window_count += 1
        return self._window_count <= MAX_COMMANDS_PER_WINDOW

    def _send_state(self, projected: ChatWire) -> None:
        """Sends sessionState when something the client sees changed, and never an older one after a newer one."""
        voice = self._deps.voice_available
        state = {**projected, "voiceAvailable": voice() if voice is not None else projected["voiceAvailable"]}
        previous = self._state
        if previous is not None and (
            state_version(state) <= state_version(previous) or same_session_state(previous, state)
        ):
            return
        self._state = state
        self._send(state)

    def _send_once(self, message: ChatWire, again: bool = False) -> None:
        message_id = message.get("id")
        if message_id is not None:
            if message_id in self._sent and not again:
                return
            self._sent.add(message_id)
        self._send(message)

    def _send(self, message: ChatWire) -> None:
        socket = self._socket
        if not socket.is_open:
            return
        if socket.buffered_amount > MAX_CHAT_BUFFERED_BYTES:
            self._log.warning(
                "chat client not reading; dropping the connection", buffered_amount=socket.buffered_amount
            )
            socket.terminate()
            return
        socket.send_text(json.dumps(message, ensure_ascii=False, separators=(",", ":")))

    # -- inbound ------------------------------------------------------------------------------------------------------

    def receive(self, data: str | bytes, is_binary: bool) -> None:
        size = len(data) if isinstance(data, bytes) else len(data.encode("utf-8"))
        if size > MAX_CHAT_MESSAGE_BYTES:
            close_with_notice(self._socket, CloseCode.MESSAGE_TOO_BIG, "message too big")
            return
        if is_binary:
            self._log.debug("chat message dropped: binary")
            return
        text = str(data)
        try:
            parsed_json = json.loads(text)
        except ValueError:
            self._log.debug("chat message dropped: not JSON")
            return
        try:
            message = parse_chat_client_message(parsed_json)
        except ValidationError as err:
            kind = parsed_json.get("type") if isinstance(parsed_json, dict) else None
            # The type (truncated) and issue paths only, never the values.
            self._log.info(
                "chat message dropped: invalid or unknown",
                type=kind[:40] if isinstance(kind, str) else None,
                issues=[".".join(str(part) for part in issue["loc"]) for issue in err.errors()],
            )
            return
        self._spawn(self._handle(message))

    async def _handle(self, message: Any) -> None:
        kind = message.type
        if kind == "inputResponse":
            if not self._within_budget():
                self._log.warning("chat answer refused: too many commands on this socket")
                self._send(input_error_wire(message.request_id, 0, TOO_FAST_MESSAGE))
                return
            await self._submit(SubmitChatInput(request_id=message.request_id, field=message.field, value=message.value))
        elif kind == "optOut":
            if not self._within_budget():
                self._log.warning("optOut dropped: too many commands on this socket")
                return
            try:
                result = await self._deps.processor.dispatch(self._session_id, OptOutRequested())
            except Exception as err:
                self._log.error("optOut failed", code=getattr(err, "sqlstate", None), message=str(err))
                return
            reply = result.reply
            if reply and reply.get("status") == "alreadyAsked" and reply.get("open"):
                self._send(input_request_wire(**reply["open"]))
        elif kind == "clientMetric":
            now = _now_ms()
            if now - self._last_metric_at < CLIENT_METRIC_INTERVAL_MS:
                return  # excess dropped (protocol.md section 7)
            self._last_metric_at = now
            await self._store_client_metric(message.turn_id, message.ms)

    async def _store_client_metric(self, turn_id: str, ms: float) -> None:
        """The browser's perceived latency for one agent turn (P11-T02). Kept only when the turn id names a call of this
        session (a client can't write into another session's turns); merged into the turn's row, whichever of the
        server's and the client's numbers arrives first. A storage error is logged, never sent to the client."""
        call_id = call_id_of_turn(turn_id)
        if call_id is None:
            return
        pool = self._deps.socket.pool
        try:
            call = await get_call(pool, call_id)
            if call is None or call.session_id != self._session_id:
                return
            await upsert_turn_metric(
                pool, turn_id=turn_id, session_id=self._session_id, call_id=call_id, client_ms=math.floor(ms + 0.5)
            )
        except Exception as err:
            self._log.warning("client metric not stored", code=getattr(err, "sqlstate", None), message=str(err))

    async def _submit(self, command: SubmitChatInput) -> None:
        reply: dict[str, Any] | None
        try:
            reply = (await self._deps.processor.dispatch(self._session_id, command)).reply
        except UnsupportedCommandError:
            reply = {"status": "stale", "message": STALE_REQUEST_MESSAGE}
        except Exception as err:
            # Code and message only: a database error's detail can quote the row (the user's answer).
            self._log.error(
                "chat input failed",
                code=getattr(err, "sqlstate", None),
                message=str(err),
                request_id=command.request_id,
            )
            self._send(input_error_wire(command.request_id, 0, ANSWER_NOT_SAVED_MESSAGE))
            return
        # Accepted and rejected answers reach the client through their committed events; only a stale one is answered
        # here, followed by the card that IS open, so a page showing the stale card switches to it (P4 review #1).
        if reply and reply.get("status") == "stale":
            self._send(input_error_wire(command.request_id, 0, reply["message"]))
            open_card = reply.get("open")
            if open_card:
                self._sent.add(open_card["id"])
                self._send(input_request_wire(**open_card))
