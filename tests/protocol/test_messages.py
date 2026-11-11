# ruff: noqa: RUF001, RUF012
"""The /chat message models (shared/protocol/schemas.ts + types.ts): inbound messages are validated leniently, outbound
ones strictly, and every message serializes to the exact camelCase wire JSON."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.protocol import (
    AudioMessage,
    CallClosingMessage,
    ChatClosingMessage,
    ChatMessage,
    ChatTranscriptMessage,
    ClientMetric,
    InputCancel,
    InputError,
    InputOption,
    InputRequest,
    InputResponse,
    OptOutRequest,
    RecordMessage,
    SessionStateMessage,
    StopPlaybackMessage,
    SyncDoneMessage,
    TranscriptMessage,
    parse_chat_client_message,
    parse_chat_server_message,
    to_wire,
)


class TestClientMessages:
    def test_parses_an_input_response_for_every_value_type(self) -> None:
        for value in ["text", 3, 3.5, True, False, ["a", "b"], [], None]:
            message = parse_chat_client_message(
                {"type": "inputResponse", "requestId": "req_x_1", "field": "email", "value": value}
            )
            assert isinstance(message, InputResponse)
            assert message.value == value
            assert message.request_id == "req_x_1"

    def test_booleans_stay_booleans_and_numbers_stay_numbers(self) -> None:
        raw: dict[str, Any] = {"type": "inputResponse", "requestId": "r", "field": "f"}
        assert parse_chat_client_message({**raw, "value": True}).value is True
        assert type(parse_chat_client_message({**raw, "value": 1}).value) is int

    def test_strips_unknown_keys(self) -> None:
        message = parse_chat_client_message({"type": "optOut", "extra": 1})
        assert isinstance(message, OptOutRequest)
        assert to_wire(message) == {"type": "optOut"}

    @pytest.mark.parametrize(
        "raw",
        [
            {"type": "nope"},
            {"type": "inputResponse", "requestId": "r", "field": "f"},  # value is required (null is fine)
            {"type": "inputResponse", "requestId": "", "field": "f", "value": 1},
            {"type": "inputResponse", "requestId": "r" * 129, "field": "f", "value": 1},
            {"type": "inputResponse", "requestId": "r", "field": "f" * 65, "value": 1},
            {"type": "inputResponse", "requestId": "r", "field": "", "value": 1},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": "x" * 1001},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": ["x"] * 13},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": [1]},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": float("inf")},
            {"type": "inputResponse", "requestId": "r", "field": "f", "value": {"a": 1}},
            {"type": "clientMetric", "name": "other", "turnId": "t", "ms": 1, "at": "x"},
            {"type": "clientMetric", "name": "turnLatency", "turnId": "t", "ms": -1, "at": "x"},
            {"type": "clientMetric", "name": "turnLatency", "turnId": "t", "ms": 60_001, "at": "x"},
            {"type": "clientMetric", "name": "turnLatency", "turnId": "t", "ms": 1, "at": ""},
            {"type": "clientMetric", "name": "turnLatency", "turnId": "t", "ms": 1, "at": "x" * 41},
            "optOut",
            None,
        ],
    )
    def test_rejects_the_wrong_shape(self, raw: Any) -> None:
        with pytest.raises(ValidationError):
            parse_chat_client_message(raw)

    def test_parses_a_client_metric(self) -> None:
        message = parse_chat_client_message(
            {"type": "clientMetric", "name": "turnLatency", "turnId": "t_1", "ms": 812.5, "at": "2026-11-10T04:00:00Z"}
        )
        assert isinstance(message, ClientMetric)
        assert (message.turn_id, message.ms) == ("t_1", 812.5)
        assert to_wire(message) == {
            "type": "clientMetric",
            "name": "turnLatency",
            "turnId": "t_1",
            "ms": 812.5,
            "at": "2026-11-10T04:00:00Z",
        }

    def test_input_response_null_value_is_kept_on_the_wire(self) -> None:
        message = InputResponse(request_id="r", field="f", value=None)
        assert to_wire(message) == {"type": "inputResponse", "requestId": "r", "field": "f", "value": None}


class TestServerMessages:
    VALID: list[dict[str, Any]] = [
        {"type": "message", "id": "m_1", "role": "agent", "text": "hi"},
        {"type": "message", "id": "m_2", "role": "user", "text": "hi", "requestId": "req_email_1"},
        {
            "type": "inputRequest",
            "id": "req_email:1_2",
            "field": "email",
            "kind": "select",
            "label": "Pick",
            "options": [{"value": "a", "label": "A"}, {"value": "b"}],
            "required": True,
            "multiple": False,
        },
        {"type": "inputError", "id": "err_req_x_1_3", "requestId": "req_x_1", "message": "bad"},
        {"type": "inputCancel", "id": "cancel_req_x_1", "requestId": "req_x_1"},
        {"type": "record", "id": "rec_1", "record": {"a": [1, None]}},
        {"type": "transcript", "id": "tu_abc_1", "role": "user", "text": "hello", "final": True},
        {
            "type": "sessionState",
            "id": "state_4",
            "status": "finalized",
            "callActive": False,
            "outcome": "optedOut",
            "revision": 2,
            "voiceAvailable": True,
            "notice": None,
        },
        {"type": "syncDone", "id": "sync_0", "lastSeq": 0},
        {"type": "closing", "code": 4410, "reason": "session closed"},
    ]

    @pytest.mark.parametrize("raw", VALID, ids=[m["type"] + str(i) for i, m in enumerate(VALID)])
    def test_round_trips_exactly(self, raw: dict[str, Any]) -> None:
        assert to_wire(parse_chat_server_message(raw)) == raw

    @pytest.mark.parametrize(
        "raw",
        [
            {"type": "message", "id": "x_1", "role": "agent", "text": "hi"},  # id pattern
            {"type": "message", "role": "agent", "text": "hi"},  # id required
            {"type": "message", "id": "m_1", "role": "robot", "text": "hi"},
            {"type": "message", "id": "m_1", "role": "agent", "text": "x" * 2001},
            {"type": "message", "id": "m_1", "role": "agent", "text": "hi", "extra": 1},  # strict
            {"type": "inputRequest", "id": "req_x_a", "field": "f", "kind": "text", "label": "L"},
            {"type": "inputRequest", "id": "req_x_1", "field": "f", "kind": "slider", "label": "L"},
            {"type": "inputRequest", "id": "req_x_1", "field": "f", "kind": "text", "label": ""},
            {"type": "inputRequest", "id": "req_x_１", "field": "f", "kind": "text", "label": "L"},  # non-ASCII digit
            {
                "type": "inputRequest",
                "id": "req_x_1",
                "field": "f",
                "kind": "select",
                "label": "L",
                "options": [{"value": "a", "x": 1}],
            },
            {"type": "inputError", "id": "err_x", "requestId": "r"},
            {"type": "inputCancel", "id": "nope", "requestId": "r"},
            {"type": "record", "id": "rec_x", "record": {}},
            {"type": "record", "id": "rec_1", "record": []},
            {"type": "transcript", "id": "tx_a_1", "role": "user", "text": "t", "final": True},
            {"type": "transcript", "id": "tu_a_1", "role": "user", "text": "t", "final": False},
            {
                "type": "sessionState",
                "id": "state_1",
                "status": "weird",
                "callActive": True,
                "outcome": None,
                "revision": None,
                "voiceAvailable": True,
                "notice": None,
            },
            {
                "type": "sessionState",
                "id": "state_1",
                "status": "active",
                "callActive": True,
                "outcome": None,
                "revision": 0,
                "voiceAvailable": True,
                "notice": None,
            },
            {
                "type": "sessionState",
                "id": "state_1",
                "status": "active",
                "callActive": True,
                "outcome": "done",
                "revision": None,
                "voiceAvailable": True,
                "notice": None,
            },
            {
                "type": "sessionState",
                "id": "state_1",
                "status": "active",
                "callActive": True,
                "revision": None,
                "voiceAvailable": True,
                "notice": None,
            },
            {"type": "syncDone", "id": "sync_1", "lastSeq": -1},
            {"type": "closing", "code": 999, "reason": "x"},
            {"type": "closing", "code": 5000, "reason": "x"},
            {"type": "closing", "code": 1000, "reason": "x" * 124},
            {"type": "unknown"},
        ],
    )
    def test_rejects_what_the_server_must_never_send(self, raw: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            parse_chat_server_message(raw)

    def test_builds_from_python_attribute_names(self) -> None:
        message = SessionStateMessage(
            id="state_1",
            status="active",
            call_active=True,
            outcome=None,
            revision=None,
            voice_available=False,
            notice="n",
        )
        assert to_wire(message) == {
            "type": "sessionState",
            "id": "state_1",
            "status": "active",
            "callActive": True,
            "outcome": None,
            "revision": None,
            "voiceAvailable": False,
            "notice": "n",
        }
        assert to_wire(SyncDoneMessage(id="sync_3", last_seq=3)) == {"type": "syncDone", "id": "sync_3", "lastSeq": 3}
        assert to_wire(ChatTranscriptMessage(id="ta_x_1", role="agent", text="t")) == {
            "type": "transcript",
            "id": "ta_x_1",
            "role": "agent",
            "text": "t",
            "final": True,
        }
        assert to_wire(ChatMessage(id="m_9", role="user", text="t", request_id="req_a_1"))["requestId"] == "req_a_1"
        assert to_wire(InputError(id="err_a_1", request_id="req_a", message=None)) == {
            "type": "inputError",
            "id": "err_a_1",
            "requestId": "req_a",
        }
        assert to_wire(InputCancel(id="cancel_a", request_id="a", reason="why"))["reason"] == "why"
        assert to_wire(RecordMessage(id="rec_1", record={"k": None})) == {
            "type": "record",
            "id": "rec_1",
            "record": {"k": None},
        }
        assert to_wire(ChatClosingMessage(code=4400, reason="invalid session id")) == {
            "type": "closing",
            "code": 4400,
            "reason": "invalid session id",
        }
        request = InputRequest(
            id="req_a_1", field="a", kind="select", label="L", options=[InputOption(value="x", label=None)]
        )
        assert to_wire(request)["options"] == [{"value": "x"}]
        assert to_wire(request)["kind"] == "select"


class TestCallMessages:
    def test_serialize_to_the_starters_wire_shapes(self) -> None:
        assert to_wire(AudioMessage(data="AAAA")) == {"type": "audio", "data": "AAAA"}
        assert to_wire(AudioMessage(sample_rate=16000, data="AAAA")) == {
            "type": "audio",
            "sampleRate": 16000,
            "data": "AAAA",
        }
        assert to_wire(StopPlaybackMessage()) == {"type": "stopPlayback"}
        assert to_wire(TranscriptMessage(role="user", text="hi", final=False)) == {
            "type": "transcript",
            "role": "user",
            "text": "hi",
            "final": False,
        }
        assert to_wire(TranscriptMessage(role="agent", text="hi", final=True, id="ta_1_1"))["id"] == "ta_1_1"
        assert to_wire(CallClosingMessage(code=4411, reason="resume required")) == {
            "type": "closing",
            "code": 4411,
            "reason": "resume required",
        }
