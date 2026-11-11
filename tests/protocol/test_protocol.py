"""The starter UI's wire contract (protocol.md section 9): these values must not change, or the copied UI breaks."""

from __future__ import annotations

from app.protocol import (
    DEFAULT_PLAYBACK_RATE,
    MIC_FRAME_BYTES,
    MIC_FRAME_MS,
    MIC_SAMPLE_RATE,
    CallServerMessageType,
    ChatClientMessageType,
    ChatServerMessageType,
    FieldSource,
    FieldStatus,
    InputKind,
    Outcome,
    Role,
)


def values(enum: type) -> list[str]:
    return [member.value for member in enum]


def test_keeps_the_audio_framing() -> None:
    """20 ms PCM16 mono frames at 16 kHz up, 24 kHz playback down."""
    assert MIC_SAMPLE_RATE == 16000
    assert MIC_FRAME_MS == 20
    assert MIC_FRAME_BYTES == 640
    assert DEFAULT_PLAYBACK_RATE == 24000


def test_keeps_the_message_type_strings() -> None:
    assert values(CallServerMessageType) == ["audio", "stopPlayback", "transcript", "closing"]
    # The starter's values, unchanged and first; protocol.md section 3.3/3.4 (P3-T04) adds the rest (additive).
    assert values(ChatServerMessageType) == [
        "message",
        "inputRequest",
        "inputError",
        "inputCancel",
        "record",
        "transcript",
        "sessionState",
        "syncDone",
        "closing",
    ]
    assert values(ChatClientMessageType) == ["inputResponse", "optOut", "clientMetric"]


def test_keeps_the_enum_values_used_in_records_and_input_cards() -> None:
    assert values(Role) == ["user", "agent"]
    assert values(InputKind) == ["text", "email", "phone", "number", "date", "select", "multiSelect", "file", "confirm"]
    assert values(Outcome) == ["completed", "partial", "optedOut", "needsReview"]
    assert values(FieldSource) == ["call", "chat"]
    # The starter's three values, unchanged and first; P2-T07 adds skipped and unverified (protocol.md section 9, additive).
    assert values(FieldStatus) == ["valid", "missing", "invalid", "skipped", "unverified"]


def test_enum_members_compare_equal_to_their_wire_strings() -> None:
    assert Outcome.OPTED_OUT == "optedOut"
    assert Role.AGENT == "agent"
    assert str(InputKind.MULTI_SELECT) == "multiSelect"
