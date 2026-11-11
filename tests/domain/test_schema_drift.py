"""shared/record.schema.json and the Python constants must describe the same record (P2-T07 risk: schema/type drift)."""

from __future__ import annotations

import json
from typing import Any

from app.domain.fields import (
    ACCEPTED_FILE_TYPES,
    CALL_FIELDS,
    CHAT_FIELDS,
    DATE_PRECISIONS,
    DEVICE_TYPES,
    FIELDS,
    MAX_FILE_BYTES,
    MAX_NOTES_CHARS,
    RECORD_FIELD_IDS,
    URGENCY_LEVELS,
)
from app.domain.record import RECORD_SCHEMA_PATH
from app.domain.validators.voice_fields import MAX_SUMMARY_CHARS, MAX_VERBATIM_CHARS
from app.protocol import SESSION_ID_PATTERN, FieldStatus, Outcome

s: Any = json.loads(RECORD_SCHEMA_PATH.read_text(encoding="utf-8"))


def field(field_id: str) -> Any:
    return s["properties"]["fields"]["properties"][field_id]


def test_names_exactly_the_catalogs_record_fields_all_required() -> None:
    assert list(s["properties"]["fields"]["properties"]) == list(RECORD_FIELD_IDS)
    assert s["properties"]["fields"]["required"] == list(RECORD_FIELD_IDS)
    assert s["properties"]["missingRequired"]["items"]["enum"] == [*CALL_FIELDS, *CHAT_FIELDS]


def test_uses_the_same_enums_as_the_code() -> None:
    assert s["$defs"]["outcome"]["enum"] == [o.value for o in Outcome]
    assert s["$defs"]["deviceType"]["enum"] == list(DEVICE_TYPES)
    assert s["$defs"]["urgency"]["properties"]["level"]["enum"] == list(URGENCY_LEVELS)
    assert s["$defs"]["problemStartedAt"]["properties"]["precision"]["enum"] == list(DATE_PRECISIONS)
    assert s["$defs"]["file"]["properties"]["mime"]["enum"] == list(ACCEPTED_FILE_TYPES)
    assert s["$defs"]["file"]["properties"]["size"]["maximum"] == MAX_FILE_BYTES
    assert s["properties"]["sessionId"]["pattern"] == SESSION_ID_PATTERN.pattern


def test_allows_the_statuses_each_field_can_really_have() -> None:
    for field_id in RECORD_FIELD_IDS:
        expected = ["valid", "invalid", "missing"]
        if FIELDS[field_id].authority == "chatOnly":
            expected.append("unverified")
        if not FIELDS[field_id].required:
            expected.append("skipped")
        assert field(field_id)["properties"]["status"]["enum"] == expected, field_id
        for status in field(field_id)["properties"]["status"]["enum"]:
            assert status in [x.value for x in FieldStatus], field_id


def test_uses_the_validators_length_limits() -> None:
    assert s["$defs"]["additionalNotes"]["maxLength"] == MAX_NOTES_CHARS
    assert s["$defs"]["problemDescription"]["properties"]["summary"]["maxLength"] == MAX_SUMMARY_CHARS
    assert s["$defs"]["problemDescription"]["properties"]["verbatim"]["maxLength"] == MAX_VERBATIM_CHARS


def test_is_a_closed_draft_2020_12_schema() -> None:
    assert s["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert s["additionalProperties"] is False
    assert s["properties"]["schemaVersion"]["const"] == "1.0"
