"""Upload checks (D10, P2-T04), pure: the type comes from the file's magic bytes, never from its name or the browser's
claim; a claimed type that disagrees with the contents is rejected. HEIC is recognised only so it can be rejected
with a clear message (P0-T01). The upload endpoint (P4-T03) streams, stores and signs; these only decide."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Literal, TypedDict

from ..fields import ACCEPTED_FILE_TYPES, MAX_ADDITIONAL_PHOTOS, MAX_FILE_BYTES
from .result import ValidationResult, invalid, skipped, valid
from .strings import clean_text, truncate

FileField = Literal["purchaseInvoice", "additionalPhotos"]
SniffedType = str  # one of ACCEPTED_FILE_TYPES, or "image/heic"

_HEIF_BRANDS = frozenset(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"])


def sniff_file_type(data: bytes) -> SniffedType | None:
    """The file's real type from its first bytes, or None when it's none of the types we recognise."""
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp" and len(data) >= 12 and data[8:12].decode("latin-1") in _HEIF_BRANDS:
        return "image/heic"
    return None


_TYPE_NAMES = {
    "application/pdf": "a PDF",
    "image/jpeg": "a JPEG image",
    "image/png": "a PNG image",
    "image/webp": "a WebP image",
    "image/heic": "a HEIC photo",
}


def _describe_type(mime: str) -> str:
    # Own keys only: the declared type comes from the client.
    return _TYPE_NAMES.get(mime) or f"“{mime}”"


def normalize_declared_type(declared: str | None) -> str | None:
    """The browser's declared type, normalised; None when it declared nothing useful (empty or octet-stream)."""
    mime = (declared or "").split(";", 1)[0].strip().lower()
    if mime in ("", "application/octet-stream"):
        return None
    if mime in ("image/jpg", "image/pjpeg"):
        return "image/jpeg"
    if mime == "image/heif":
        return "image/heic"
    return mime


class CheckedFile(TypedDict):
    """What the files table stores for an accepted upload; the record later adds the file id and a signed URL."""

    mime: str
    size: int
    sha256: str
    originalName: str | None


_FIELD_TYPES: dict[str, tuple[str, ...]] = {
    "purchaseInvoice": ACCEPTED_FILE_TYPES,
    "additionalPhotos": tuple(t for t in ACCEPTED_FILE_TYPES if t.startswith("image/")),
}

MAX_FILE_NAME_CHARS = 255


def sanitize_file_name(name: str | None) -> str | None:
    """Keeps the last path segment, cleaned and capped, so a name can never act as a path."""
    if not name:
        return None
    base = re.split(r"[\\/]", clean_text(name))[-1]
    cleaned = truncate(re.sub(r"^\.+", "", base), MAX_FILE_NAME_CHARS)
    return None if cleaned == "" else cleaned


def validate_upload(
    field: FileField, *, bytes: bytes, declared_type: str | None = None, name: str | None = None
) -> ValidationResult[CheckedFile]:
    """`bytes`: the whole file; `declared_type`: the browser's claim; `name`: display only, never a path."""
    data = bytes  # the keyword mirrors the TS option name; `bytes` is the file contents here
    if len(data) == 0:
        return invalid("That file is empty.")
    if len(data) > MAX_FILE_BYTES:
        return invalid("That file is larger than 10 MB.")
    sniffed = sniff_file_type(data)
    if sniffed == "image/heic":
        # Name only what this field accepts: a PDF is fine for the invoice but not as a photo.
        return invalid(
            "HEIC photos aren't supported. Please upload a JPEG, PNG or WebP image instead."
            if field == "additionalPhotos"
            else "HEIC photos aren't supported. Please upload a PDF, JPEG, PNG or WebP file instead."
        )
    allowed = _FIELD_TYPES[field]
    if sniffed is None:
        return invalid(
            "Photos must be JPEG, PNG or WebP images."
            if field == "additionalPhotos"
            else "Please upload a PDF, JPEG, PNG or WebP file."
        )
    declared = normalize_declared_type(declared_type)
    if declared is not None and declared != sniffed:
        return invalid(
            f"That file is labelled as {_describe_type(declared)} but it's actually {_describe_type(sniffed)}."
        )
    if sniffed not in allowed:
        return invalid("Photos must be JPEG, PNG or WebP images.")
    return valid(
        CheckedFile(
            mime=sniffed,
            size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            originalName=sanitize_file_name(name),
        )
    )


# `file:<fileId>`, the opaque upload reference (protocol.md section 8). Ids are server-generated base64url.
_FILE_REF = re.compile(r"file:([A-Za-z0-9_-]{8,64})")


def parse_file_ref(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = _FILE_REF.fullmatch(value)
    return match.group(1) if match else None


def validate_file_selection(field: FileField, value: Any) -> ValidationResult[list[str]]:
    """The answer to a file card: one ref for the invoice; 0-5 refs for photos (None = skipped). Returns the file ids;
    whether each file exists and belongs to this session is checked against the database by the caller (P4-T02)."""
    is_list = isinstance(value, list | tuple)
    if field == "purchaseInvoice":
        if value is None or (is_list and len(value) == 0):
            return invalid("Please upload your purchase invoice.")
        if is_list and len(value) > 1:
            return invalid("Please upload just one invoice file.")
        file_id = parse_file_ref(value[0] if is_list else value)
        return valid([file_id]) if file_id else invalid("That upload wasn't recognised. Please try again.")
    if value is None or (is_list and len(value) == 0):
        return skipped()
    refs = list(value) if is_list else [value]
    if len(refs) > MAX_ADDITIONAL_PHOTOS:
        return invalid(f"You can add up to {MAX_ADDITIONAL_PHOTOS} photos.")
    ids = [parse_file_ref(ref) for ref in refs]
    if any(i is None for i in ids):
        return invalid("One of the uploads wasn't recognised. Please try again.")
    if len(set(ids)) != len(ids):
        return invalid("The same photo was attached twice.")
    return valid([i for i in ids if i is not None])
