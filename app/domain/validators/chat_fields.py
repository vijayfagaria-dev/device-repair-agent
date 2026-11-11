"""Validators for the fields collected in chat (D14, P2-T03). Every rejection says exactly what is wrong, in one
short sentence the chat card shows under the input."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

import idna

from ..fields import MAX_NOTES_CHARS, SerialNumberValue, ServiceCentreValue
from ..service_centres import SERVICE_CENTRES, find_service_centre
from .result import ValidationResult, invalid, skipped, valid
from .strings import char_length, clean_text, words

# protocol.md section 7: inputResponse strings are capped per field before validation.
MAX_SERIAL_INPUT_CHARS = 64
MAX_EMAIL_CHARS = 254


def passes_luhn(digits: str) -> bool:
    """Luhn check digit validation (ISO/IEC 7812), used by IMEIs."""
    total = 0
    for i in range(len(digits)):
        digit = ord(digits[len(digits) - 1 - i]) - 48
        if i % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def _is_one_repeated_char(value: str) -> bool:
    return re.fullmatch(r"(.)\1*", value) is not None


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def validate_serial_number(raw: Any) -> ValidationResult[SerialNumberValue]:
    """IMEI or serial number. Normalized: NFKC (full-width digits -> ASCII), spaces and hyphens removed, uppercase.
    All digits -> an IMEI (exactly 15 digits, passes Luhn). Otherwise a serial: 8-20 letters and digits, with at least
    one letter, and not one character repeated."""
    if not isinstance(raw, str) or clean_text(raw) == "":
        return invalid("Please type the serial number or IMEI.")
    if char_length(raw) > MAX_SERIAL_INPUT_CHARS:
        return invalid("That's too long for a serial number or IMEI.")
    value = re.sub(r"[\s-]", "", clean_text(raw, form="NFKC")).upper()
    if re.fullmatch(r"\d+", value, re.ASCII):
        if len(value) != 15:
            return invalid(f"That IMEI has {_plural(len(value), 'digit')}; IMEIs have 15.")
        if _is_one_repeated_char(value):
            return invalid("That doesn't look like a real IMEI. Please check it.")
        if not passes_luhn(value):
            return invalid("That IMEI's last digit doesn't match the others. Please check each digit.")
        return valid({"kind": "imei", "value": value})
    if not re.fullmatch(r"[A-Z0-9]+", value):
        return invalid("Serial numbers use only letters and digits.")
    if len(value) < 8 or len(value) > 20:
        return invalid(f"That serial number has {_plural(len(value), 'character')}; serial numbers have 8 to 20.")
    if _is_one_repeated_char(value):
        return invalid("That doesn't look like a real serial number. Please check it.")
    return valid({"kind": "serial", "value": value})


# Characters RFC 5322 allows unquoted in a local part (plus any non-ASCII letter, for internationalized mail).
_LOCAL_PART_PUNCTUATION = frozenset("!#$%&'*+/=?^_`{|}~.-")
_DOMAIN_LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")
_TLD = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")


def _is_local_part(local: str) -> bool:
    return len(local) > 0 and all(
        c in _LOCAL_PART_PUNCTUATION or unicodedata.category(c)[0] in ("L", "N") for c in local
    )


# WHATWG "forbidden domain code points" (beyond C0 controls and DEL).
_FORBIDDEN_DOMAIN_CHARS = frozenset(" #%/:<>?@[\\]^|")


def domain_to_ascii(domain: str) -> str:
    """WHATWG domainToASCII (UTS #46, non-transitional, no hyphen/STD3 checks): "" when the domain is invalid.
    Done label by label so the 253-character total is checked by the caller, as the TS did."""
    try:
        mapped = idna.uts46_remap(domain, std3_rules=False, transitional=False)
        if any(c in _FORBIDDEN_DOMAIN_CHARS or ord(c) <= 0x1F or ord(c) == 0x7F for c in mapped):
            return ""
        labels = []
        for label in mapped.split("."):
            labels.append(idna.alabel(label).decode("ascii") if label and not label.isascii() else label)
        return ".".join(labels)
    except (idna.IDNAError, UnicodeError):
        return ""


def validate_email(raw: Any) -> ValidationResult[str]:
    """Permissive structural email check (D14): one @, a plausible local part, a domain with a TLD. Normalized:
    trimmed, the domain lowercased and converted to its ASCII (punycode) form; the local part is kept as typed.
    `+tags` are fine."""
    if not isinstance(raw, str) or clean_text(raw) == "":
        return invalid("Please type your email address.")
    text = clean_text(raw, form="NFC")
    if re.search(r"\s", text):
        return invalid("Email addresses can't contain spaces.")
    if char_length(text) > MAX_EMAIL_CHARS:
        return invalid("That email address is too long.")
    parts = text.split("@")
    if len(parts) == 1:
        return invalid("That email address is missing the @.")
    if len(parts) > 2:
        return invalid("That email address has more than one @.")
    local, domain = parts
    if local == "":
        return invalid("Something is missing before the @.")
    if char_length(local) > 64:
        return invalid("The part before the @ is too long.")
    if not _is_local_part(local) or local.startswith(".") or local.endswith(".") or ".." in local:
        return invalid("The part before the @ has characters an email address can't use.")
    ascii_domain = "" if ".." in domain else domain_to_ascii(domain.lower())
    labels = ascii_domain.split(".")
    if (
        ascii_domain == ""
        or len(labels) < 2
        or not all(_DOMAIN_LABEL.fullmatch(label) for label in labels)
        or not _TLD.fullmatch(labels[-1])
    ):
        return invalid("The part after the @ needs a domain like example.com.")
    # Re-checked after the punycode conversion: "ä.ä.ä..." grows about fourfold ("xn--4ca..."), and the stored address
    # must still fit the limit (the record schema caps it at 254).
    address = f"{local}@{ascii_domain}"
    if len(ascii_domain) > 253 or char_length(address) > MAX_EMAIL_CHARS:
        return invalid("That email address is too long.")
    return valid(address)


def _place(centre_name: str) -> str:
    return re.sub(r" Demo Repair Centre$", "", centre_name)


def validate_service_centre(raw: Any, *, spoken: bool = False) -> ValidationResult[ServiceCentreValue]:
    """A service centre from the server's list (never the client's). From the chat card the value is a centre id; when
    `spoken`, it may also be a place name heard on the call ("the Koramangala one")."""
    pick = "Please choose a service centre from the list."
    if not isinstance(raw, str) or clean_text(raw) == "":
        return invalid(pick)
    by_id = find_service_centre(clean_text(raw))
    if by_id:
        return valid(by_id)
    if not spoken:
        return invalid(pick)

    heard = words(raw)
    matches = [c for c in SERVICE_CENTRES if all(word in heard for word in words(_place(c.name)))]
    if len(matches) == 1:
        return valid(matches[0].to_dict())
    in_city = [c for c in SERVICE_CENTRES if c.city.lower() in heard]
    if len(in_city) > 1:
        places = " or ".join(_place(c.name) for c in in_city)
        return invalid(f"There are {len(in_city)} centres in {in_city[0].city}: {places}. Which one?")
    return invalid("I couldn't match that to one of our centres. I'll send you the list in the chat.")


def validate_additional_notes(raw: Any) -> ValidationResult[str]:
    """Optional free text for the technician. None or empty means skipped."""
    if raw is None:
        return skipped()
    if not isinstance(raw, str):
        return invalid("Please type your notes as text.")
    text = clean_text(raw, form="NFC", multiline=True)
    if text == "":
        return skipped()
    if char_length(text) > MAX_NOTES_CHARS:
        return invalid(f"Notes can be up to {MAX_NOTES_CHARS:,} characters; this is {char_length(text):,}.")
    return valid(text)


def validate_submit_confirmation(raw: Any) -> ValidationResult[bool]:
    """The "Submit claim?" card: Yes or No. What No leads to (the edit card) is the controller's business."""
    return valid(raw) if isinstance(raw, bool) else invalid("Please tap Yes or No.")
