"""Pydantic models for every WebSocket message (shared/protocol/types.ts + schemas.ts).

Client -> server models ignore unknown keys (forward compatible); server -> client models are strict (extra keys are
rejected, every id the protocol requires is present), exactly as the zod schemas were. Attributes are snake_case; the
wire keys are camelCase (aliases). Serialize with `to_wire(message)` (or `message.model_dump(mode="json")`): optional
fields that are None are omitted, fields the protocol sends as `null` (see `_NULLABLE`) are kept.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, TypedDict

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_serializer,
)
from pydantic.alias_generators import to_camel

from .enums import InputKind, Outcome, Role

# protocol.md section 7: inputResponse strings are capped at 1,000 characters (stricter per-field limits apply later).
MAX_INPUT_STRING_CHARS = 1000
# A file card answers with at most this many refs (12 files per session, protocol.md section 8).
MAX_INPUT_ARRAY_ITEMS = 12
# Ids we generate are short; anything longer is not one of ours.
MAX_ID_CHARS = 128
# protocol.md section 7: outbound message text is at most 2,000 characters.
MAX_MESSAGE_TEXT_CHARS = 2000

# Patterns use [0-9] rather than \d: pydantic's regex engine treats \d as any Unicode digit, zod's did not.
Id = Annotated[StrictStr, Field(min_length=1, max_length=MAX_ID_CHARS)]
ShortString = Annotated[StrictStr, Field(max_length=MAX_INPUT_STRING_CHARS)]
FiniteNumber = Annotated[StrictInt | StrictFloat, Field(allow_inf_nan=False)]
# bool first: JSON true is never a number here (strict int/float reject bool).
InputValue = (
    StrictBool
    | FiniteNumber
    | ShortString
    | Annotated[list[ShortString], Field(max_length=MAX_INPUT_ARRAY_ITEMS)]
    | None
)


class WireModel(BaseModel):
    """Base of every wire message: camelCase aliases, None-valued optional keys omitted on output."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True)
    # Wire keys that are sent as null (not omitted) when None.
    _NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_none(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        return {k: v for k, v in data.items() if v is not None or k in self._NULLABLE}


class StrictWireModel(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True, extra="forbid")


def to_wire(message: BaseModel) -> dict[str, Any]:
    """The JSON-ready dict for a wire message (camelCase keys, None optionals omitted)."""
    return message.model_dump(mode="json", by_alias=True)


# ---------------------------------------------------------------------------------------------------------------------
# Call (/call) server -> browser messages


class AudioMessage(WireModel):
    type: Literal["audio"] = "audio"
    sample_rate: int | None = None  # defaults to DEFAULT_PLAYBACK_RATE
    data: str


class StopPlaybackMessage(WireModel):
    type: Literal["stopPlayback"] = "stopPlayback"


class TranscriptMessage(WireModel):
    type: Literal["transcript"] = "transcript"
    role: Role
    text: str
    final: bool
    id: str | None = None


class CallClosingMessage(WireModel):
    """Sent right before the server closes a socket with `code` (protocol.md v1.7). Same shape on /call and /chat."""

    type: Literal["closing"] = "closing"
    code: int
    reason: str


CallServerMessage = AudioMessage | StopPlaybackMessage | TranscriptMessage | CallClosingMessage


# ---------------------------------------------------------------------------------------------------------------------
# Chat (/chat) server -> client messages (strict)


class ChatMessage(StrictWireModel):
    type: Literal["message"] = "message"
    id: Annotated[StrictStr, Field(pattern=r"^m_[A-Za-z0-9_-]+$")]
    role: Role
    text: Annotated[StrictStr, Field(max_length=MAX_MESSAGE_TEXT_CHARS)]
    # Role `user` only: the input card this message answers (protocol.md v1.2, additive).
    request_id: Id | None = None


class InputOption(StrictWireModel):
    value: StrictStr
    label: StrictStr | None = None


class InputRequest(StrictWireModel):
    type: Literal["inputRequest"] = "inputRequest"
    id: Annotated[StrictStr, Field(pattern=r"^req_[A-Za-z0-9:]+_[0-9]+$")]
    field: Annotated[StrictStr, Field(min_length=1)]
    kind: InputKind
    label: Annotated[StrictStr, Field(min_length=1)]
    help: StrictStr | None = None
    placeholder: StrictStr | None = None
    required: StrictBool | None = None
    pattern: StrictStr | None = None  # JavaScript RegExp source, checked before sending
    options: list[InputOption] | None = None  # select, multiSelect
    accept: StrictStr | None = None  # file: same syntax as <input accept>
    multiple: StrictBool | None = None  # file: value becomes an array of URLs


class InputError(StrictWireModel):
    type: Literal["inputError"] = "inputError"
    id: Annotated[StrictStr, Field(pattern=r"^err_.+_[0-9]+$")]
    request_id: Id
    message: StrictStr | None = None


class InputCancel(StrictWireModel):
    type: Literal["inputCancel"] = "inputCancel"
    id: Annotated[StrictStr, Field(pattern=r"^cancel_.+$")]
    request_id: Id
    reason: StrictStr | None = None


class RecordMessage(StrictWireModel):
    """The record payload itself is checked against shared/record.schema.json (app.domain.record), not here."""

    type: Literal["record"] = "record"
    id: Annotated[StrictStr, Field(pattern=r"^rec_[0-9]+$")]
    record: dict[str, Any]


class ChatTranscriptMessage(StrictWireModel):
    """A final call transcript line replayed on /chat (protocol.md section 3.3). Same id as on /call."""

    type: Literal["transcript"] = "transcript"
    id: Annotated[StrictStr, Field(pattern=r"^t[ua]_[A-Za-z0-9_-]+_[0-9]+$")]
    role: Role
    text: StrictStr
    final: Literal[True] = True


SessionStatus = Literal["active", "finalized", "closed"]


class SessionStateMessage(StrictWireModel):
    """Sent after replay and whenever one of its values changes (protocol.md section 3.3)."""

    _NULLABLE: ClassVar[frozenset[str]] = frozenset({"outcome", "revision", "notice"})

    type: Literal["sessionState"] = "sessionState"
    id: Annotated[StrictStr, Field(pattern=r"^state_[0-9]+$")]
    status: SessionStatus
    call_active: StrictBool
    outcome: Outcome | None
    revision: Annotated[StrictInt, Field(ge=1)] | None
    voice_available: StrictBool
    notice: StrictStr | None


class SyncDoneMessage(StrictWireModel):
    """Ends the replay: live messages after it are newer than `last_seq` (protocol.md section 4)."""

    type: Literal["syncDone"] = "syncDone"
    id: Annotated[StrictStr, Field(pattern=r"^sync_[0-9]+$")]
    last_seq: Annotated[StrictInt, Field(ge=0)]


class ChatClosingMessage(StrictWireModel):
    type: Literal["closing"] = "closing"
    code: Annotated[StrictInt, Field(ge=1000, le=4999)]
    reason: Annotated[StrictStr, Field(max_length=123)]


ChatServerMessage = Annotated[
    ChatMessage
    | InputRequest
    | InputError
    | InputCancel
    | RecordMessage
    | ChatTranscriptMessage
    | SessionStateMessage
    | SyncDoneMessage
    | ChatClosingMessage,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------------------------------------------------
# Chat client -> server messages (lenient: unknown keys are ignored)


class InputResponse(WireModel):
    type: Literal["inputResponse"] = "inputResponse"
    request_id: Id
    field: Annotated[StrictStr, Field(min_length=1, max_length=64)]
    value: InputValue  # required, but may be null (the card's Skip)

    _NULLABLE: ClassVar[frozenset[str]] = frozenset({"value"})


class OptOutRequest(WireModel):
    """The chat Stop button (protocol.md section 3.4; P4-T05)."""

    type: Literal["optOut"] = "optOut"


class ClientMetric(WireModel):
    """Client-side turn latency probe (protocol.md section 3.4; P11-T02)."""

    type: Literal["clientMetric"] = "clientMetric"
    name: Literal["turnLatency"]
    turn_id: Id
    ms: Annotated[StrictInt | StrictFloat, Field(ge=0, le=60_000, allow_inf_nan=False)]
    at: Annotated[StrictStr, Field(min_length=1, max_length=40)]


ChatClientMessage = Annotated[InputResponse | OptOutRequest | ClientMetric, Field(discriminator="type")]


class UploadResponse(BaseModel):
    url: str


# ---------------------------------------------------------------------------------------------------------------------
# Record wire types (plain JSON dicts; the record is built and validated in app.domain.record)


class RecordField(TypedDict):
    value: Any
    source: Literal["call", "chat"] | None
    collectedAt: str | None  # ISO 8601 with offset
    status: Literal["valid", "missing", "invalid", "skipped", "unverified"]


class RecordConflict(TypedDict):
    field: str
    callValue: Any
    chatValue: Any
    resolution: str
    reason: str


FinalRecord = dict[str, Any]
