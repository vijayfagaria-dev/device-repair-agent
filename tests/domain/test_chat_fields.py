# ruff: noqa: RUF001
"""Chat-field validators (P2-T03, D14): table tests; every rejection has a specific message."""

from __future__ import annotations

from typing import Any

import pytest

from app.domain.validators.chat_fields import (
    domain_to_ascii,
    passes_luhn,
    validate_additional_notes,
    validate_email,
    validate_serial_number,
    validate_service_centre,
    validate_submit_confirmation,
)


def ok(result: Any) -> Any:
    assert result.status == "valid", result
    return result.normalized


def err(result: Any) -> str | None:
    assert result.status == "invalid", result
    return result.error


def test_passes_luhn_accepts_known_valid_imeis_and_rejects_a_one_digit_change() -> None:
    for imei in ["490154203237518", "356938035643809", "352099001761481"]:
        assert passes_luhn(imei), imei
    for imei in ["490154203237519", "490154203237528", "356938035643808"]:
        assert not passes_luhn(imei), imei


class TestValidateSerialNumber:
    @pytest.mark.parametrize(
        ("text", "normalized"),
        [
            ("490154203237518", {"kind": "imei", "value": "490154203237518"}),
            ("35 209900 176148 1", {"kind": "imei", "value": "352099001761481"}),
            ("35-209900-176148-1", {"kind": "imei", "value": "352099001761481"}),
            (
                "３５２０９９００１７６１４８１",
                {"kind": "imei", "value": "352099001761481"},
            ),  # full-width digits (NFKC)
            ("c02xl0ghjg5h", {"kind": "serial", "value": "C02XL0GHJG5H"}),
            ("  R58N 1234 ABC ", {"kind": "serial", "value": "R58N1234ABC"}),
            ("ABCDEFGH", {"kind": "serial", "value": "ABCDEFGH"}),
            ("A1234567890123456789", {"kind": "serial", "value": "A1234567890123456789"}),  # 20 characters
        ],
    )
    def test_accepts(self, text: str, normalized: dict[str, str]) -> None:
        assert ok(validate_serial_number(text)) == normalized

    @pytest.mark.parametrize(
        ("raw", "error"),
        [
            ("35209900176148", "That IMEI has 14 digits; IMEIs have 15."),
            ("3520990017614811", "That IMEI has 16 digits; IMEIs have 15."),
            ("1", "That IMEI has 1 digit; IMEIs have 15."),
            ("490154203237519", "That IMEI's last digit doesn't match the others. Please check each digit."),
            ("000000000000000", "That doesn't look like a real IMEI. Please check it."),
            ("AAAAAAAA", "That doesn't look like a real serial number. Please check it."),
            ("ABC123", "That serial number has 6 characters; serial numbers have 8 to 20."),
            ("A12345678901234567890", "That serial number has 21 characters; serial numbers have 8 to 20."),
            ("ABC#12345", "Serial numbers use only letters and digits."),
            ("C02XL0GH/JG5H", "Serial numbers use only letters and digits."),
            ("٣٥٢٠٩٩٠٠١٧٦١٤٨١", "Serial numbers use only letters and digits."),  # Arabic-Indic digits are not ASCII
            ("", "Please type the serial number or IMEI."),
            ("   ", "Please type the serial number or IMEI."),
            (None, "Please type the serial number or IMEI."),
            (490154203237518, "Please type the serial number or IMEI."),
            ("9" * 65, "That's too long for a serial number or IMEI."),
        ],
    )
    def test_rejects_with_a_specific_message(self, raw: Any, error: str) -> None:
        assert err(validate_serial_number(raw)) == error


class TestValidateEmail:
    @pytest.mark.parametrize(
        ("text", "normalized"),
        [
            ("asha.rao@example.com", "asha.rao@example.com"),
            ("  Asha.Rao@Example.COM ", "Asha.Rao@example.com"),  # domain lowercased, local part kept
            ("asha+claims@example.co.in", "asha+claims@example.co.in"),
            ("o'brien@example.ie", "o'brien@example.ie"),
            ("user@xn--bcher-kva.de", "user@xn--bcher-kva.de"),  # punycode domain
            ("user@bücher.de", "user@xn--bcher-kva.de"),  # Unicode domain -> punycode
            ("user@sub-domain.example.org", "user@sub-domain.example.org"),
            ("user@example.xn--p1ai", "user@example.xn--p1ai"),
        ],
    )
    def test_accepts(self, text: str, normalized: str) -> None:
        assert ok(validate_email(text)) == normalized

    @pytest.mark.parametrize(
        ("raw", "error"),
        [
            ("a@b", "The part after the @ needs a domain like example.com."),
            ("foo@@x.com", "That email address has more than one @."),
            ("foo@bar@x.com", "That email address has more than one @."),
            ("foo.example.com", "That email address is missing the @."),
            ("@example.com", "Something is missing before the @."),
            ("asha rao@example.com", "Email addresses can't contain spaces."),
            ("asha@exa mple.com", "Email addresses can't contain spaces."),
            (".asha@example.com", "The part before the @ has characters an email address can't use."),
            ("asha..rao@example.com", "The part before the @ has characters an email address can't use."),
            ("asha<script>@example.com", "The part before the @ has characters an email address can't use."),
            ("asha@-example.com", "The part after the @ needs a domain like example.com."),
            ("asha@example..com", "The part after the @ needs a domain like example.com."),
            ("asha@example.c", "The part after the @ needs a domain like example.com."),
            ("asha@example.123", "The part after the @ needs a domain like example.com."),
            ("asha@example.com.", "The part after the @ needs a domain like example.com."),
            (f"{'a' * 65}@example.com", "The part before the @ is too long."),
            (f"a@{'b' * 250}.com", "That email address is too long."),
            # P2 audit: 225 characters typed, but 885 after punycode; the record used to cut it to 254.
            (f"a@{'.'.join(['ä'] * 110)}.com", "That email address is too long."),
            ("", "Please type your email address."),
            (42, "Please type your email address."),
        ],
    )
    def test_rejects_with_a_specific_message(self, raw: Any, error: str) -> None:
        assert err(validate_email(raw)) == error

    def test_domain_to_ascii_returns_empty_for_invalid_domains(self) -> None:
        assert domain_to_ascii("bücher.de") == "xn--bcher-kva.de"
        assert domain_to_ascii("exa mple.com") == ""
        assert domain_to_ascii(f"{'ä' * 70}.com") == ""  # a label over 63 characters after conversion


class TestValidateServiceCentre:
    def test_accepts_an_id_from_the_servers_list(self) -> None:
        assert ok(validate_service_centre("blr-koramangala")) == {
            "id": "blr-koramangala",
            "name": "Koramangala Demo Repair Centre",
            "city": "Bengaluru",
        }

    @pytest.mark.parametrize(
        "value", ["blr-forged", "BLR-KORAMANGALA", "Koramangala", "", None, 3, ["blr-koramangala"]]
    )
    def test_rejects_a_forged_or_unknown_value_from_the_chat_card(self, value: Any) -> None:
        assert err(validate_service_centre(value)) == "Please choose a service centre from the list."

    def test_matches_a_place_heard_on_the_call_and_asks_which_one_when_a_city_has_two(self) -> None:
        assert ok(validate_service_centre("the Koramangala one please", spoken=True))["id"] == "blr-koramangala"
        assert ok(validate_service_centre("Karol Bagh", spoken=True))["id"] == "del-karol-bagh"
        assert (
            err(validate_service_centre("somewhere in Mumbai", spoken=True))
            == "There are 2 centres in Mumbai: Andheri or Dadar. Which one?"
        )
        assert (
            err(validate_service_centre("Chennai", spoken=True))
            == "I couldn't match that to one of our centres. I'll send you the list in the chat."
        )


class TestValidateAdditionalNotes:
    def test_cleans_text_keeping_line_breaks(self) -> None:
        assert ok(validate_additional_notes("  Please call\u0007 before   visiting.\r\n\r\n\r\nGate code 12 ")) == (
            "Please call before visiting.\n\nGate code 12"
        )

    def test_treats_none_empty_and_whitespace_as_skipped(self) -> None:
        for value in [None, "", "   \n "]:
            assert validate_additional_notes(value).status == "skipped"

    def test_accepts_exactly_1000_characters_and_rejects_more_counting_emoji_as_one_each(self) -> None:
        assert validate_additional_notes("😀" * 1000).status == "valid"
        assert err(validate_additional_notes("x" * 1001)) == "Notes can be up to 1,000 characters; this is 1,001."
        assert err(validate_additional_notes(12)) == "Please type your notes as text."

    def test_strips_invisible_bidirectional_and_zero_width_characters(self) -> None:
        assert ok(validate_additional_notes("abc\u202edef\u200bghi")) == "abcdefghi"


def test_validate_submit_confirmation_accepts_only_booleans() -> None:
    assert ok(validate_submit_confirmation(True)) is True
    assert ok(validate_submit_confirmation(False)) is False
    for value in ["yes", 1, None]:
        assert err(validate_submit_confirmation(value)) == "Please tap Yes or No."
