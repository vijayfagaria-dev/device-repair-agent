"""File validation (P2-T04, D10): magic bytes decide the type; size, count and declared-vs-real mismatches are
rejected."""

from __future__ import annotations

import base64
import hashlib
from typing import Any

import pytest

from app.domain.validators.files import (
    normalize_declared_type,
    parse_file_ref,
    sanitize_file_name,
    sniff_file_type,
    validate_file_selection,
    validate_upload,
)

PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]) + b"JFIF\x00" + bytes([0x01, 0x01, 0x00, 0xFF, 0xD9])
WEBP = b"RIFF" + bytes([0x1A, 0, 0, 0]) + b"WEBPVP8 " + bytes([0x0E] + [0] * 13)
HEIC = bytes([0, 0, 0, 0x18]) + b"ftypheic" + bytes([0, 0, 0, 0]) + b"mif1heic"
TEXT = b"Invoice #123\nTotal: 999\n"


class TestSniffFileType:
    def test_recognises_the_four_accepted_types_and_heic_by_their_first_bytes(self) -> None:
        assert sniff_file_type(PDF) == "application/pdf"
        assert sniff_file_type(PNG) == "image/png"
        assert sniff_file_type(JPEG) == "image/jpeg"
        assert sniff_file_type(WEBP) == "image/webp"
        assert sniff_file_type(HEIC) == "image/heic"

    def test_returns_none_for_anything_else_including_truncated_signatures(self) -> None:
        for sample in [
            TEXT,
            b"MZ\x90\x00",
            b"%PD",
            b"RIFF1234WAVE",
            bytes([0x89, 0x50, 0x4E]),
            b"",
            b"\0\0\0\x18ftypxxxx" + b"\0" * 4,
        ]:
            assert sniff_file_type(sample) is None


class TestValidateUpload:
    def test_accepts_a_tiny_pdf_and_png_returning_size_sha256_and_a_safe_name(self) -> None:
        result = validate_upload("purchaseInvoice", bytes=PDF, declared_type="application/pdf", name="invoice.pdf")
        assert result.status == "valid"
        assert result.normalized == {
            "mime": "application/pdf",
            "size": len(PDF),
            "sha256": hashlib.sha256(PDF).hexdigest(),
            "originalName": "invoice.pdf",
        }
        photo = validate_upload("additionalPhotos", bytes=PNG, declared_type="image/png", name="damage.png")
        assert photo.status == "valid"
        assert photo.normalized["mime"] == "image/png"  # type: ignore[index]
        assert photo.normalized["size"] == len(PNG)  # type: ignore[index]

    def test_uses_the_sniffed_type_when_the_browser_declares_nothing_useful(self) -> None:
        for declared in [None, "", "application/octet-stream"]:
            result = validate_upload("purchaseInvoice", bytes=JPEG, declared_type=declared)
            assert result.status == "valid"
            assert result.normalized["mime"] == "image/jpeg"  # type: ignore[index]
        assert validate_upload("purchaseInvoice", bytes=JPEG, declared_type="image/jpg").status == "valid"
        assert validate_upload("purchaseInvoice", bytes=JPEG).status == "valid"

    @pytest.mark.parametrize(
        ("field", "kwargs", "error"),
        [
            ("purchaseInvoice", {"bytes": TEXT, "declared_type": "application/pdf", "name": "invoice.pdf"}, "Please upload a PDF, JPEG, PNG or WebP file."),
            ("purchaseInvoice", {"bytes": b"", "declared_type": "application/pdf"}, "That file is empty."),
            ("purchaseInvoice", {"bytes": PDF + bytes(10 * 1024 * 1024 + 1 - len(PDF))}, "That file is larger than 10 MB."),
            ("purchaseInvoice", {"bytes": PNG, "declared_type": "application/pdf"}, "That file is labelled as a PDF but it's actually a PNG image."),
            ("purchaseInvoice", {"bytes": PDF, "declared_type": "text/plain"}, "That file is labelled as “text/plain” but it's actually a PDF."),
            # P2 audit: the photo message used to suggest a PDF, which photos then refuse.
            ("additionalPhotos", {"bytes": HEIC, "declared_type": "image/heic"}, "HEIC photos aren't supported. Please upload a JPEG, PNG or WebP image instead."),
            ("purchaseInvoice", {"bytes": HEIC, "declared_type": "image/heic"}, "HEIC photos aren't supported. Please upload a PDF, JPEG, PNG or WebP file instead."),
            # P2 audit: a forged declared type named after an Object.prototype key used to print native code.
            ("purchaseInvoice", {"bytes": PDF, "declared_type": "constructor"}, "That file is labelled as “constructor” but it's actually a PDF."),
            ("additionalPhotos", {"bytes": PDF, "declared_type": "application/pdf"}, "Photos must be JPEG, PNG or WebP images."),
            ("additionalPhotos", {"bytes": TEXT}, "Photos must be JPEG, PNG or WebP images."),
        ],
        ids=[
            "a renamed .txt", "a 0-byte file", "a file just over 10 MB", "a PNG claiming to be a PDF",
            "a PDF claiming to be text", "a HEIC photo", "a HEIC invoice", "a declared type of constructor",
            "a PDF as a photo", "a text file as a photo",
        ],
    )  # fmt: skip
    def test_rejects(self, field: Any, kwargs: dict[str, Any], error: str) -> None:
        result = validate_upload(field, **kwargs)
        assert (result.status, result.error) == ("invalid", error)

    def test_accepts_exactly_10_mb(self) -> None:
        ten_mb = PDF + bytes(10 * 1024 * 1024 - len(PDF))
        result = validate_upload("purchaseInvoice", bytes=ten_mb)
        assert result.status == "valid"
        assert result.normalized["size"] == 10 * 1024 * 1024  # type: ignore[index]


class TestNamesAndDeclaredTypes:
    def test_keeps_only_a_cleaned_last_path_segment(self) -> None:
        assert sanitize_file_name("../../etc/passwd") == "passwd"
        assert sanitize_file_name("C:\\Users\\me\\invoice.pdf") == "invoice.pdf"
        assert sanitize_file_name(".htaccess") == "htaccess"
        assert sanitize_file_name("in\u202evoice.pdf") == "invoice.pdf"
        assert len(sanitize_file_name(f"{'a' * 300}.pdf") or "") <= 255
        for empty in [None, "", "...", "/"]:
            assert sanitize_file_name(empty) is None

    def test_normalizes_declared_types(self) -> None:
        assert normalize_declared_type("IMAGE/JPEG; charset=binary") == "image/jpeg"
        assert normalize_declared_type("image/pjpeg") == "image/jpeg"
        assert normalize_declared_type("image/heif") == "image/heic"
        assert normalize_declared_type("application/octet-stream") is None
        assert normalize_declared_type(None) is None


class TestFileCardAnswers:
    def test_parses_file_id_refs_only(self) -> None:
        assert parse_file_ref("file:fA3k9QzL2mXw") == "fA3k9QzL2mXw"
        for bad in ["fA3k9QzL2mXw", "file:", "file:../../x", "file:abc", "https://x/y", 5, None, "file:fA3k9QzL2mXw\n"]:
            assert parse_file_ref(bad) is None

    def test_requires_exactly_one_invoice(self) -> None:
        def result(value: Any) -> tuple[str, Any, Any]:
            r = validate_file_selection("purchaseInvoice", value)
            return r.status, r.normalized, r.error

        assert result("file:fA3k9QzL2mXw") == ("valid", ["fA3k9QzL2mXw"], None)
        assert result(["file:fA3k9QzL2mXw"]) == ("valid", ["fA3k9QzL2mXw"], None)
        assert result(None) == ("invalid", None, "Please upload your purchase invoice.")
        assert result([]) == ("invalid", None, "Please upload your purchase invoice.")
        assert result(["file:aaaaaaaaaa", "file:bbbbbbbbbb"]) == (
            "invalid",
            None,
            "Please upload just one invoice file.",
        )
        assert result("nope") == ("invalid", None, "That upload wasn't recognised. Please try again.")

    def test_allows_0_to_5_distinct_photos_none_meaning_skipped(self) -> None:
        def result(value: Any) -> tuple[str, Any, Any]:
            r = validate_file_selection("additionalPhotos", value)
            return r.status, r.normalized, r.error

        assert result(None) == ("skipped", None, None)
        assert result([]) == ("skipped", None, None)
        five = [f"file:photo000{i}" for i in range(5)]
        assert result(five) == ("valid", [ref[5:] for ref in five], None)
        assert result("file:photo0001") == ("valid", ["photo0001"], None)
        assert result([*five, "file:photo0005"]) == ("invalid", None, "You can add up to 5 photos.")
        assert result(["file:photo0001", "file:photo0001"]) == ("invalid", None, "The same photo was attached twice.")
        assert result(["file:photo0001", "x"]) == (
            "invalid",
            None,
            "One of the uploads wasn't recognised. Please try again.",
        )
