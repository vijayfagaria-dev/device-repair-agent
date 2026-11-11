"""The record sanitization oracle (P6-T02, architecture section 7).

Deliberately independent of the builder: it re-states what a sanitized record may contain (its own caps, its own list
of forbidden content) and scans a finished record or an API response. A violation names a path and a rule, never the
offending value.

Two layers:
 - ``leak_violations(value)``: infrastructure leaks anywhere in any JSON (internal paths, ``file:`` refs, provider ids,
   credentials, secrets that are actually configured, hidden keys, signed links where none belong). For DTOs.
 - ``record_violations(record)``: the above on every structural string of a record, plus hygiene (no control or
   invisible characters, NFC, collapsed whitespace), per-field length caps, and the shape of signed file links. Free
   text the user wrote (a problem description, notes) is held to hygiene and caps, and to configured secrets, but not
   to the leak patterns: a person may legitimately type "see file: x" in their notes.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from app.domain.fields import RECORD_FIELD_IDS


@dataclass(frozen=True, slots=True)
class Violation:
    path: str
    rule: str


#: Forbidden content in structural (system-controlled) strings and in DTOs.
LEAK_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("internal path /data/", re.compile(r"/data/")),
    ("internal path", re.compile(r"(^|[\s\"'=(])/(tmp|var|home|Users|etc|opt|srv|root|mnt)/")),
    ("internal file ref (file:)", re.compile(r"(?<![A-Za-z0-9_-])file:[A-Za-z0-9]")),
    ("api key (sk-)", re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{4,}")),
    ("api key (gsk_)", re.compile(r"(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{4,}")),
    ("api key (AIza)", re.compile(r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{8,}")),
    ("api key (dg_)", re.compile(r"(?<![A-Za-z0-9_-])dg_[A-Za-z0-9]{6,}")),
    ("bearer token", re.compile(r"\bBearer\s+\S{6,}", re.IGNORECASE)),
    ("database url", re.compile(r"\bpostgres(ql)?://", re.IGNORECASE)),
    # Groq/OpenAI-style ids; our own ids (req_serialNumber_1, m_..., tu_c...) never look like these.
    (
        "provider request id",
        re.compile(r"(?<![A-Za-z0-9_-])(chatcmpl-[A-Za-z0-9]{6,}|(req|resp|msg|run)_0[0-9a-z]{10,})"),
    ),
    (
        "provider request id (uuid after a provider name)",
        re.compile(r"\b(deepgram|groq|gemini)[\w-]*[:=]\s*[0-9a-f]{8}-[0-9a-f]{4}-", re.IGNORECASE),
    ),
]

#: The same hidden keys the read API strips (http/sessions.ts), restated here on purpose.
HIDDEN_KEY = re.compile(
    r"(secret|token$|password|passwd|api_?key|authorization|cookie|path$|storage_?key|^evidence$|^provider\w*id$)",
    re.IGNORECASE,
)

#: C0/C1 controls (a newline is allowed only in notes, where it is removed before this test), zero-width, bidi and tag
#: characters, BOM.
CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿\U000e0000-\U000e007f\U000e0100-\U000e01ef]")
SIGNED_URL = re.compile(r"^https?://[^\s?#]+/files/f[A-Za-z0-9_-]+\?exp=\d{1,12}&sig=[A-Za-z0-9_-]{6,}$")
IST_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$")

#: Max length in code points per logical path (``[]`` = any array index). Anything unlisted is capped at 1,000.
CAPS: list[tuple[re.Pattern[str], int]] = [
    (re.compile(r"^fields\.(deviceType|email)\.value$"), 254),
    (re.compile(r"^fields\.additionalNotes\.value$"), 1000),
    (re.compile(r"^fields\.deviceModel\.value\.(brand|model)$"), 80),
    (re.compile(r"^fields\.problemDescription\.value\.summary$"), 300),
    (re.compile(r"^fields\.problemDescription\.value\.verbatim$"), 1000),
    (re.compile(r"^fields\.problemStartedAt\.value\.spoken$"), 200),
    (re.compile(r"^fields\.urgency\.value\.reason$"), 200),
    (re.compile(r"^fields\.serviceCentre\.value\.name$"), 100),
    (re.compile(r"^fields\.serviceCentre\.value\.city$"), 60),
    (re.compile(r"^fields\.serialNumber\.value\.value$"), 20),
    (re.compile(r"^outcomeReason$"), 1000),
    (re.compile(r"^reviewFlags\[\]\.reason$"), 300),
    (re.compile(r"^conflicts\[\]\.reason$"), 300),
]

#: Free text the user (or the model, quoting them) wrote.
FREE_TEXT: list[re.Pattern[str]] = [
    re.compile(r"^fields\.deviceModel\.value\.(brand|model)$"),  # what the user named ("SK-1200" is a real model)
    re.compile(r"^fields\.problemDescription\.value\.(summary|verbatim)$"),
    re.compile(r"^fields\.problemStartedAt\.value\.spoken$"),
    re.compile(r"^fields\.urgency\.value\.reason$"),
    re.compile(r"^fields\.additionalNotes\.value$"),
    re.compile(r"^reviewFlags\[\]\.reason$"),
]


def _is_free_text(record: dict[str, Any], logical: str) -> bool:
    """A needsReview reason is "needs review: R-1 <flag reason>" (outcome), so it carries the flags' free text."""
    return any(p.search(logical) for p in FREE_TEXT) or (
        logical == "outcomeReason" and record.get("outcome") == "needsReview"
    )


def _walk(
    value: Any,
    path: str,
    visit: Callable[[str, str], None],
    on_key: Callable[[str, str], None] | None = None,
) -> None:
    if isinstance(value, str):
        visit(path, value)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _walk(item, f"{path}[{i}]", visit, on_key)
    elif isinstance(value, dict):
        for key, item in value.items():
            if on_key:
                on_key(path, key)
            _walk(item, key if path == "" else f"{path}.{key}", visit, on_key)


def _secret_violations(path: str, text: str, secrets: Sequence[str]) -> list[Violation]:
    return [Violation(path, "configured secret")] if any(len(s) >= 8 and s in text for s in secrets) else []


def _leak_rules(text: str) -> list[str]:
    return [rule for rule, pattern in LEAK_PATTERNS if pattern.search(text)]


def leak_violations(value: Any, secrets: Sequence[str] = (), allow_signed_urls: bool = False) -> list[Violation]:
    """Infrastructure leaks anywhere in a JSON value. ``allow_signed_urls`` is true only for records."""
    found: list[Violation] = []

    def visit(path: str, text: str) -> None:
        for rule in _leak_rules(text):
            found.append(Violation(path, rule))
        found.extend(_secret_violations(path, text, secrets))
        if not allow_signed_urls and re.search(r"[?&]sig=", text):
            found.append(Violation(path, "signed link outside a record"))

    def on_key(path: str, key: str) -> None:
        full = key if path == "" else f"{path}.{key}"
        if HIDDEN_KEY.search(key):
            found.append(Violation(full, "hidden key"))
        if not allow_signed_urls and key == "url":
            found.append(Violation(full, "url key outside a record"))

    _walk(value, "", visit, on_key)
    return found


def _logical_path(record: dict[str, Any], path: str) -> str:
    """``conflicts[0].callValue.summary`` is the same logical value as ``fields.<field>.value.summary``."""
    generic = re.sub(r"\[\d+\]", "[]", path)
    match = re.match(r"^conflicts\[(\d+)\]\.(callValue|chatValue)(.*)$", path)
    if not match:
        return generic
    conflicts = record.get("conflicts")
    conflict = (
        conflicts[int(match.group(1))] if isinstance(conflicts, list) and int(match.group(1)) < len(conflicts) else None
    )
    field = conflict.get("field") if isinstance(conflict, dict) else None
    return f"fields.{field}.value{re.sub(r'\[\d+\]', '[]', match.group(3))}" if isinstance(field, str) else generic


def record_violations(record: Any, secrets: Sequence[str] = ()) -> list[Violation]:
    """Everything wrong with a record, in terms a failing test can print safely (paths and rules only)."""
    if not isinstance(record, dict):
        return [Violation("", "record is not an object")]
    found: list[Violation] = []

    def visit(path: str, text: str) -> None:
        logical = _logical_path(record, path)
        multiline = logical == "fields.additionalNotes.value"
        is_url = bool(re.search(r"\.url$", path)) and bool(
            re.match(r"^fields\.(purchaseInvoice|additionalPhotos)", logical)
        )

        # Hygiene (all strings).
        if CONTROL.search(text.replace("\n", "") if multiline else text):
            found.append(Violation(path, "control or invisible character"))
        if text != unicodedata.normalize("NFC", text):
            found.append(Violation(path, "not NFC"))
        if not multiline and (re.search(r"\s{2,}", text) or text != text.strip()):
            found.append(Violation(path, "uncollapsed whitespace"))
        if multiline and (text != text.strip() or re.search(r"\n{3,}", text) or re.search(r"[ \t]{2,}", text)):
            found.append(Violation(path, "uncollapsed whitespace"))

        # Caps.
        cap = next((c for pattern, c in CAPS if pattern.search(logical)), 1000)
        if len(text) > cap:
            found.append(Violation(path, f"longer than {cap}"))

        # Secrets are forbidden everywhere; leak patterns only outside free text and outside a file's signed link.
        found.extend(_secret_violations(path, text, secrets))
        if is_url:
            if not SIGNED_URL.search(text):
                found.append(Violation(path, "file link is not a signed /files/ link"))
        elif not _is_free_text(record, logical):
            for rule in _leak_rules(text):
                found.append(Violation(path, rule))

    def on_key(path: str, key: str) -> None:
        # The schema forbids extra keys; this catches a leak that happens to be a valid key name.
        if HIDDEN_KEY.search(key):
            found.append(Violation(key if path == "" else f"{path}.{key}", "hidden key"))

    _walk(record, "", visit, on_key)

    for key in ("createdAt", "endedAt"):
        value = record.get(key)
        if not isinstance(value, str) or not IST_ISO.search(value):
            found.append(Violation(key, "timestamp is not IST ISO-8601"))
    fields = record.get("fields")
    if not isinstance(fields, dict):
        found.append(Violation("fields", "missing"))
    else:
        for field_id in RECORD_FIELD_IDS:
            entry = fields.get(field_id)
            if not isinstance(entry, dict):
                found.append(Violation(f"fields.{field_id}", "missing field entry"))
                continue
            collected = entry.get("collectedAt")
            if isinstance(collected, str) and not IST_ISO.search(collected):
                found.append(Violation(f"fields.{field_id}.collectedAt", "timestamp is not IST ISO-8601"))
            # A field with no value says so (status), and a value never comes without a source.
            if entry.get("value") is None and entry.get("status") in ("valid", "unverified"):
                found.append(Violation(f"fields.{field_id}", "valid or unverified field without a value"))
            if entry.get("value") is not None and entry.get("source") is None:
                found.append(Violation(f"fields.{field_id}", "value without a source"))
        for key in fields:
            if key not in RECORD_FIELD_IDS:
                found.append(Violation(f"fields.{key}", "unknown field"))
    return found


def expect_sanitized_record(record: Any, secrets: Sequence[str] = ()) -> None:
    """Raises with every violation (paths and rules) so a failing test shows what and where, never the values."""
    found = record_violations(record, secrets)
    if found:
        lines = "\n".join(f"  {v.path or '(root)'}: {v.rule}" for v in found)
        raise AssertionError(f"record is not sanitized:\n{lines}")


def expect_no_leaks(value: Any, secrets: Sequence[str] = (), allow_signed_urls: bool = False) -> None:
    found = leak_violations(value, secrets, allow_signed_urls)
    if found:
        lines = "\n".join(f"  {v.path or '(root)'}: {v.rule}" for v in found)
        raise AssertionError(f"leaks found:\n{lines}")
