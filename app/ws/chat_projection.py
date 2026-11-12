"""What the chat socket sends (protocol.md section 3.3), from committed events (live) or stored rows (replay, section 4).

Both paths build their messages with the same functions below, so a replayed message is byte-identical to the one sent
live: same id, same fields. Ids follow protocol.md section 1.1 and are stable across reconnects and restarts. Messages
are plain dicts with the wire's camelCase keys (validate them with ``app.protocol.parse_chat_server_message``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeGuard

from app.db.repos.events import SessionEvent
from app.protocol.enums import Role

ChatWire = dict[str, Any]


def _is_object(value: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _role(value: Any) -> str:
    return str(Role.USER.value) if value == Role.USER else str(Role.AGENT.value)


def chat_message_wire(*, id: str, role: str, text: str, request_id: str | None = None) -> ChatWire:
    message: ChatWire = {"type": "message", "id": f"m_{id}", "role": _role(role), "text": text}
    if role == Role.USER and request_id:
        message["requestId"] = request_id
    return message


def transcript_wire(*, id: str, role: str, text: str) -> ChatWire:
    """Only final lines are stored, so a replayed or projected transcript line is always final."""
    return {"type": "transcript", "id": id, "role": _role(role), "text": text, "final": True}


def input_request_wire(*, id: str, field: str, spec: Mapping[str, Any]) -> ChatWire:
    """The card: the stored spec (the catalog's card, P2-T01) plus the request's id and field. A stored spec can never
    override the request's own type, id or field."""
    rest = {k: v for k, v in spec.items() if k not in ("type", "id", "field")}
    return {**rest, "type": "inputRequest", "id": id, "field": field}


def input_error_wire(request_id: str, attempt: int, message: str) -> ChatWire:
    return {"type": "inputError", "id": f"err_{request_id}_{attempt}", "requestId": request_id, "message": message}


def input_cancel_wire(request_id: str, reason: str | None = None) -> ChatWire:
    message: ChatWire = {"type": "inputCancel", "id": f"cancel_{request_id}", "requestId": request_id}
    if reason:
        message["reason"] = reason
    return message


def record_wire(revision: int, record: Mapping[str, Any]) -> ChatWire:
    return {"type": "record", "id": f"rec_{revision}", "record": dict(record)}


def session_state_wire(session: Any) -> ChatWire:
    """The session as the client sees it. `voiceAvailable` is true here; the chat socket sets the live value from the
    quota guard when it sends (P10-T03). `notice` is null until the server writes notices (P8-T01)."""
    return {
        "type": "sessionState",
        "id": f"state_{session.version}",
        "status": str(getattr(session.status, "value", session.status)),
        "callActive": session.active_call_id is not None,
        "outcome": None if session.outcome is None else str(getattr(session.outcome, "value", session.outcome)),
        "revision": session.current_revision if session.current_revision > 0 else None,
        "voiceAvailable": True,
        "notice": None,
    }


def sync_done_wire(last_seq: int) -> ChatWire:
    return {"type": "syncDone", "id": f"sync_{last_seq}", "lastSeq": last_seq}


def same_session_state(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    """True when two sessionState messages show the client the same thing (the id, i.e. the version, aside)."""
    return all(a[key] == b[key] for key in ("status", "callActive", "outcome", "revision", "voiceAvailable", "notice"))


def state_version(state: Mapping[str, Any]) -> int:
    return int(str(state["id"])[len("state_") :])


def to_chat_messages(event: SessionEvent, record: Mapping[str, Any] | None = None) -> list[ChatWire]:
    """One committed event -> the chat messages it means for the client (D12 event types). Events that aren't
    chat-visible (session.created, timer.fired, field.candidate, input.paused, ...) give nothing.

    `session.finalized` projects to the `record` message (id `rec_<revision>`, P6-T03) when the update carries that
    revision's record. The record isn't in the event payload, so the timeline never holds its signed file URLs; replay
    reads the latest from the records table instead. A new revision has a new id, and the page replaces the record card
    it shows rather than adding a second.
    """
    payload = event.payload
    kind = event.type
    if kind == "chat.message":
        message = payload.get("message")
        if not _is_object(message) or not _str(message.get("id")) or not _str(message.get("role")):
            return []
        if not isinstance(message.get("text"), str):
            return []
        return [
            chat_message_wire(
                id=message["id"], role=message["role"], text=message["text"], request_id=_str(message.get("requestId"))
            )
        ]
    if kind == "transcript.final":
        line = payload.get("line")
        if not _is_object(line) or not _str(line.get("id")) or not isinstance(line.get("text"), str):
            return []
        return [transcript_wire(id=line["id"], role=str(line.get("role")), text=line["text"])]
    if kind in ("input.requested", "input.resumed"):
        request = payload.get("request")
        if (
            not _is_object(request)
            or request.get("status") != "open"
            or not _str(request.get("id"))
            or not _str(request.get("field"))
            or not _is_object(request.get("spec"))
        ):
            return []
        return [input_request_wire(id=request["id"], field=request["field"], spec=request["spec"])]
    if kind == "input.rejected":
        request_id = _str(payload.get("requestId"))
        attempt = payload.get("attempt")
        if not request_id or not isinstance(attempt, int) or isinstance(attempt, bool):
            return []
        return [
            input_error_wire(
                request_id, attempt, _str(payload.get("message")) or "Please check this value and try again."
            )
        ]
    if kind == "input.cancelled":
        request = payload.get("request")
        request_id = _str(payload.get("requestId")) or (_str(request.get("id")) if _is_object(request) else None)
        return [input_cancel_wire(request_id, _str(payload.get("reason")))] if request_id else []
    if kind == "session.finalized":
        if record is not None and payload.get("revision") == record["revision"]:
            return [record_wire(record["revision"], record["payload"])]
        return []
    return []
