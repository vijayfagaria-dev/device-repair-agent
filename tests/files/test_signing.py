"""Signed file URLs. Vectors were produced by the TS signer (createFileUrlSigner) so the two servers stay compatible."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

from app.files.signing import DEFAULT_FILE_URL_TTL_SECONDS, create_file_url_signer


class FakeSecret:
    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value


NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
SIGNER = create_file_url_signer(
    secret=FakeSecret("test-file-url-secret-0123456789abcdef"), public_origin="https://repair.example.com"
)


def parts(url: str) -> tuple[str, str]:
    query = parse_qs(urlsplit(url).query)
    return query["exp"][0], query["sig"][0]


def test_sign_matches_the_ts_server_byte_for_byte() -> None:
    assert (
        SIGNER.sign("f_abc123", NOW)
        == "https://repair.example.com/files/f_abc123?exp=1796731200&sig=G3x3iN7CrPJ8yJJTjeBJpgB4tZBPkLAGSA3g3mNTe6I"
    )
    assert (
        SIGNER.sign("f/ä b", NOW)
        == "https://repair.example.com/files/f%2F%C3%A4%20b?exp=1796731200&sig=YzeeCz0gAs5KRksYRCVeSaitdjWaTo22s8J6m4DVXWU"
    )


def test_a_fresh_link_checks_ok_and_expires_after_the_ttl() -> None:
    exp, sig = parts(SIGNER.sign("f_1", NOW))
    assert int(exp) == int(NOW.timestamp()) + DEFAULT_FILE_URL_TTL_SECONDS
    assert SIGNER.check("f_1", exp, sig, NOW) == "ok"
    assert SIGNER.check("f_1", exp, sig, NOW + timedelta(seconds=DEFAULT_FILE_URL_TTL_SECONDS)) == "ok"
    assert (
        SIGNER.check("f_1", exp, sig, NOW + timedelta(seconds=DEFAULT_FILE_URL_TTL_SECONDS, milliseconds=1))
        == "expired"
    )


def test_a_custom_ttl_is_honoured() -> None:
    short = create_file_url_signer(secret=FakeSecret("s"), public_origin="https://x.test", ttl_seconds=60)
    exp, sig = parts(short.sign("f_1", NOW))
    assert int(exp) == int(NOW.timestamp()) + 60
    assert short.check("f_1", exp, sig, NOW + timedelta(seconds=61)) == "expired"


def test_a_changed_file_id_expiry_or_signature_is_a_bad_signature_reported_before_expiry() -> None:
    exp, sig = parts(SIGNER.sign("f_1", NOW))
    later = NOW + timedelta(days=365)
    assert SIGNER.check("f_2", exp, sig, NOW) == "badSignature"
    assert SIGNER.check("f_1", str(int(exp) + 1), sig, NOW) == "badSignature"
    assert SIGNER.check("f_1", exp, sig[:-1] + ("A" if sig[-1] != "A" else "B"), NOW) == "badSignature"
    assert SIGNER.check("f_2", exp, sig, later) == "badSignature"  # not "expired"
    other = create_file_url_signer(secret=FakeSecret("another"), public_origin="https://repair.example.com")
    assert other.check("f_1", exp, sig, NOW) == "badSignature"


def test_malformed_or_missing_parameters_are_a_bad_signature() -> None:
    exp, sig = parts(SIGNER.sign("f_1", NOW))
    for bad_exp, bad_sig in (
        (None, sig),
        (exp, None),
        ([exp], sig),
        ("", sig),
        ("1234567890123", sig),
        (exp + "\n", sig),
        ("١٧٩٦٧٣١٢٠٠", sig),
        (exp, sig + "A"),
        (exp, sig[:-1]),
        (exp, sig + "\n"),
        (exp, "+" * 43),
    ):
        assert SIGNER.check("f_1", bad_exp, bad_sig, NOW) == "badSignature"
