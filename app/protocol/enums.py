"""Wire enums (shared/protocol/enums.ts). Member names are UPPER_SNAKE; the values are the wire strings."""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    USER = "user"
    AGENT = "agent"


class CallServerMessageType(StrEnum):
    AUDIO = "audio"
    STOP_PLAYBACK = "stopPlayback"
    TRANSCRIPT = "transcript"
    # Sent just before the server closes the socket with a code (protocol.md v1.7).
    CLOSING = "closing"


class ChatServerMessageType(StrEnum):
    MESSAGE = "message"
    INPUT_REQUEST = "inputRequest"
    INPUT_ERROR = "inputError"
    INPUT_CANCEL = "inputCancel"
    RECORD = "record"
    # Added by protocol.md v1.0 (section 3.3), after the starter's five.
    TRANSCRIPT = "transcript"
    SESSION_STATE = "sessionState"
    SYNC_DONE = "syncDone"
    CLOSING = "closing"


class ChatClientMessageType(StrEnum):
    INPUT_RESPONSE = "inputResponse"
    # Added by protocol.md v1.0 (section 3.4).
    OPT_OUT = "optOut"
    CLIENT_METRIC = "clientMetric"


class InputKind(StrEnum):
    TEXT = "text"
    EMAIL = "email"
    PHONE = "phone"
    NUMBER = "number"
    DATE = "date"
    SELECT = "select"
    MULTI_SELECT = "multiSelect"
    FILE = "file"
    CONFIRM = "confirm"


class Outcome(StrEnum):
    COMPLETED = "completed"
    PARTIAL = "partial"
    OPTED_OUT = "optedOut"
    NEEDS_REVIEW = "needsReview"


class FieldSource(StrEnum):
    CALL = "call"
    CHAT = "chat"


class FieldStatus(StrEnum):
    VALID = "valid"
    MISSING = "missing"
    INVALID = "invalid"
    # An optional field the user explicitly skipped (protocol.md section 9, P2-T07).
    SKIPPED = "skipped"
    # An identifier heard only on the call: noted, never accepted until typed (D13).
    UNVERIFIED = "unverified"
