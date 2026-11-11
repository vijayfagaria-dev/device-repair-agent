"""Field catalog invariants (P2-T01, D14)."""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path

import pytest

from app.domain.fields import (
    CALL_FIELDS,
    CHAT_FIELDS,
    FIELD_IDS,
    FIELDS,
    OPTIONAL_FIELDS,
    RECORD_FIELD_IDS,
    REQUIRED_RECORD_FIELDS,
    describe_fields_for_prompt,
    is_field_id,
)
from app.domain.service_centres import SERVICE_CENTRES, find_service_centre, service_centre_label
from app.protocol import InputKind

ALL = list(FIELDS.values())
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class TestFieldCatalog:
    def test_has_5_call_fields_4_chat_fields_2_optional_fields_and_1_confirmation_field(self) -> None:
        assert [f.id for f in ALL if f.primary_channel == "call"] == list(CALL_FIELDS)
        assert [
            f.id for f in ALL if f.primary_channel == "chat" and f.required and f.id != "submitConfirmation"
        ] == list(CHAT_FIELDS)
        assert [f.id for f in ALL if not f.required] == list(OPTIONAL_FIELDS)
        assert [f.id for f in ALL if f.card.kind == InputKind.CONFIRM] == ["submitConfirmation"]
        assert list(FIELDS) == list(FIELD_IDS)
        assert len(RECORD_FIELD_IDS) == 11
        assert (*CALL_FIELDS, *CHAT_FIELDS) == REQUIRED_RECORD_FIELDS

    def test_keys_each_definition_by_its_own_id(self) -> None:
        for key, field in FIELDS.items():
            assert field.id == key

    def test_gives_every_field_a_chat_card_so_a_session_can_finish_in_chat_after_the_call_drops(self) -> None:
        for field in ALL:
            assert field.card.label != "", field.id
            assert field.card.required == field.required, field.id
        # Voice fields get the fallback kinds named in D13.
        assert FIELDS["deviceType"].card.kind == InputKind.SELECT
        assert FIELDS["deviceModel"].card.kind == InputKind.TEXT
        assert FIELDS["problemDescription"].card.kind == InputKind.TEXT
        assert FIELDS["problemStartedAt"].card.kind == InputKind.DATE
        assert FIELDS["urgency"].card.kind == InputKind.SELECT

    def test_makes_exactly_serial_number_and_email_chat_only(self) -> None:
        assert [f.id for f in ALL if f.authority == "chatOnly"] == ["serialNumber", "email"]
        for field_id in ("serialNumber", "email"):
            assert FIELDS[field_id].conflict_class == "identifier"

    def test_never_lets_the_call_agent_store_files_notes_or_the_confirmation(self) -> None:
        assert [f.id for f in ALL if not f.spoken_capture] == [
            "purchaseInvoice",
            "additionalPhotos",
            "additionalNotes",
            "submitConfirmation",
        ]
        for field in [f for f in ALL if not f.spoken_capture]:
            assert field.conflict_class == "chatInput", field.id

    def test_uses_the_d15_conflict_classes(self) -> None:
        classes = {f.id: f.conflict_class for f in ALL}
        expected = {
            "deviceType": "choice",
            "serviceCentre": "choice",
            "problemDescription": "narrative",
            "problemStartedAt": "narrative",
            "urgency": "narrative",
            "deviceModel": "typedPreferred",
        }
        assert {k: classes[k] for k in expected} == expected

    def test_offers_only_server_listed_service_centres_and_accepts_only_the_four_upload_types(self) -> None:
        options = FIELDS["serviceCentre"].card.options or ()
        assert [o.value for o in options] == [c.id for c in SERVICE_CENTRES]
        assert FIELDS["purchaseInvoice"].card.accept == "application/pdf,image/jpeg,image/png,image/webp"
        photos = FIELDS["additionalPhotos"].card
        assert (photos.accept, photos.multiple) == ("image/jpeg,image/png,image/webp", True)
        for field in ALL:
            if field.card.accept:
                assert not re.search(r"heic|heif", field.card.accept, re.IGNORECASE), field.id

    def test_has_card_patterns_that_compile(self) -> None:
        for field in ALL:
            if field.card.pattern:
                re.compile(field.card.pattern)

    def test_matches_the_approved_card_specs(self) -> None:
        """The TS snapshot (server/test/domain/__snapshots__/fields.test.ts.snap), as JSON."""
        approved = json.loads((FIXTURES / "field_cards.json").read_text(encoding="utf-8"))
        actual = {f.id: f.card.to_dict() for f in ALL}
        assert actual == approved
        # Same key order inside the wire dicts the planner will build from them.
        assert {k: list(v) for k, v in actual.items()}["deviceType"] == ["kind", "label", "required", "options"]

    def test_is_field_id_accepts_only_catalog_ids(self) -> None:
        assert is_field_id("email")
        for value in ["Email", "__proto__", "constructor", "", 1, None]:
            assert not is_field_id(value)


class TestServiceCentres:
    """PD8."""

    def test_is_a_small_clearly_fictional_list_across_three_cities_with_unique_ids(self) -> None:
        assert len(SERVICE_CENTRES) == 6
        assert len({c.id for c in SERVICE_CENTRES}) == 6
        assert {c.city for c in SERVICE_CENTRES} == {"Bengaluru", "Mumbai", "Delhi"}
        for centre in SERVICE_CENTRES:
            assert "Demo" in centre.name

    def test_returns_copies_so_callers_cannot_change_the_list(self) -> None:
        centre = find_service_centre("mum-dadar")
        assert centre == {"id": "mum-dadar", "name": "Dadar Demo Repair Centre", "city": "Mumbai"}
        assert centre is not None
        centre["name"] = "changed"
        found = find_service_centre("mum-dadar")
        assert found is not None
        assert found["name"] == "Dadar Demo Repair Centre"
        assert find_service_centre("nope") is None
        assert isinstance(SERVICE_CENTRES, tuple)
        for entry in SERVICE_CENTRES:
            with pytest.raises(dataclasses.FrozenInstanceError):
                entry.name = "x"  # type: ignore[misc]
        assert service_centre_label(SERVICE_CENTRES[0]) == "Koramangala Demo Repair Centre, Bengaluru"
        assert service_centre_label(SERVICE_CENTRES[0].to_dict()) == "Koramangala Demo Repair Centre, Bengaluru"

    def test_freezes_the_whole_catalog_cards_and_option_lists_included(self) -> None:
        card = FIELDS["serviceCentre"].card
        options = card.options or ()
        with pytest.raises(TypeError):
            FIELDS["forged"] = FIELDS["email"]  # type: ignore[index]
        with pytest.raises(dataclasses.FrozenInstanceError):
            card.label = "x"  # type: ignore[misc]
        with pytest.raises(dataclasses.FrozenInstanceError):
            FIELDS["email"].label = "x"  # type: ignore[misc]
        assert isinstance(options, tuple)
        with pytest.raises(AttributeError):
            options.append({"value": "forged"})  # type: ignore[attr-defined]
        for option in options:
            with pytest.raises(dataclasses.FrozenInstanceError):
                option.value = "x"  # type: ignore[misc]


class TestPromptDescription:
    def test_lists_every_field_once_grouped_by_channel_deterministically(self) -> None:
        text = describe_fields_for_prompt()
        assert text == describe_fields_for_prompt()
        for field_id in FIELD_IDS:
            assert len(re.findall(rf"^- {field_id} \(", text, re.MULTILINE)) == 1, field_id
        assert "- serialNumber (required): the IMEI or serial number; it must be typed" in text
        assert "- additionalNotes (optional)" in text
        assert text.index("Collect on the call") < text.index("Collect in the chat")
