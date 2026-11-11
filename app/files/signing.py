"""Signed, expiring file URLs (D10, P4-T03): `GET /files/:fileId?exp=<unix seconds>&sig=<HMAC>`.

Records carry these, so a consumer can fetch the invoice and photos without a session. The signature covers the file id
and the expiry, so neither can be changed; FILE_URL_SECRET never leaves the server. Links are byte-compatible with the
TS server: HMAC-SHA256 over `<fileId>.<exp>`, unpadded base64url, `exp` in whole unix seconds.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol
from urllib.parse import quote

#: Default lifetime of a signed link (protocol.md section 8): 30 days.
DEFAULT_FILE_URL_TTL_SECONDS = 30 * 24 * 60 * 60

FileUrlCheck = Literal["ok", "badSignature", "expired"]

_EXP = re.compile(r"\d{1,12}", re.ASCII)
_SIG = re.compile(r"[A-Za-z0-9_-]{43}", re.ASCII)


class SecretLike(Protocol):
    """`app.config.Secret`: anything with `reveal()`."""

    def reveal(self) -> str: ...


@dataclass(frozen=True, slots=True)
class FileUrlSigner:
    secret: SecretLike
    public_origin: str
    ttl_seconds: int = DEFAULT_FILE_URL_TTL_SECONDS

    def _mac(self, file_id: str, exp: str) -> bytes:
        return hmac.new(self.secret.reveal().encode(), f"{file_id}.{exp}".encode(), hashlib.sha256).digest()

    def sign(self, file_id: str, now: datetime) -> str:
        """An absolute download URL for the file, valid for the configured lifetime from `now`."""
        exp = str(math.floor(now.timestamp()) + self.ttl_seconds)
        sig = base64.urlsafe_b64encode(self._mac(file_id, exp)).rstrip(b"=").decode()
        # encodeURIComponent leaves A-Z a-z 0-9 - _ . ! ~ * ' ( ) unescaped.
        return f"{self.public_origin}/files/{quote(file_id, safe="-_.!~*'()")}?exp={exp}&sig={sig}"

    def check(self, file_id: str, exp: Any, sig: Any, now: datetime) -> FileUrlCheck:
        """Checks a request's `exp` and `sig` (as received, unparsed). A bad signature is reported before expiry."""
        if not isinstance(exp, str) or not _EXP.fullmatch(exp) or not isinstance(sig, str) or not _SIG.fullmatch(sig):
            return "badSignature"
        expected = self._mac(file_id, exp)
        given = base64.urlsafe_b64decode(sig + "=")
        if len(given) != len(expected) or not hmac.compare_digest(given, expected):
            return "badSignature"
        return "expired" if int(exp) * 1000 < now.timestamp() * 1000 else "ok"


def create_file_url_signer(*, secret: SecretLike, public_origin: str, ttl_seconds: int | None = None) -> FileUrlSigner:
    return FileUrlSigner(
        secret=secret,
        public_origin=public_origin,
        ttl_seconds=DEFAULT_FILE_URL_TTL_SECONDS if ttl_seconds is None else ttl_seconds,
    )
