"""Field validators (D14): code decides whether a value is acceptable, never the LLM."""

from __future__ import annotations

from .chat_fields import (
    MAX_EMAIL_CHARS,
    MAX_SERIAL_INPUT_CHARS,
    passes_luhn,
    validate_additional_notes,
    validate_email,
    validate_serial_number,
    validate_service_centre,
    validate_submit_confirmation,
)
from .files import (
    MAX_FILE_NAME_CHARS,
    CheckedFile,
    FileField,
    normalize_declared_type,
    parse_file_ref,
    sanitize_file_name,
    sniff_file_type,
    validate_file_selection,
    validate_upload,
)
from .result import ValidationResult, invalid, skipped, valid
from .spoken_date import ResolvedDate, is_unknown_date_phrase, resolve_spoken_date
from .strings import char_length, clean_text, has_phrase, phrase_starts, truncate, words
from .voice_fields import (
    MAX_PROBLEM_AGE_YEARS,
    MAX_SUMMARY_CHARS,
    MAX_URGENCY_REASON_CHARS,
    MAX_VERBATIM_CHARS,
    detect_brand,
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)

__all__ = [
    "MAX_EMAIL_CHARS",
    "MAX_FILE_NAME_CHARS",
    "MAX_PROBLEM_AGE_YEARS",
    "MAX_SERIAL_INPUT_CHARS",
    "MAX_SUMMARY_CHARS",
    "MAX_URGENCY_REASON_CHARS",
    "MAX_VERBATIM_CHARS",
    "CheckedFile",
    "FileField",
    "ResolvedDate",
    "ValidationResult",
    "char_length",
    "clean_text",
    "detect_brand",
    "has_phrase",
    "invalid",
    "is_unknown_date_phrase",
    "normalize_declared_type",
    "parse_file_ref",
    "passes_luhn",
    "phrase_starts",
    "resolve_spoken_date",
    "sanitize_file_name",
    "skipped",
    "sniff_file_type",
    "truncate",
    "valid",
    "validate_additional_notes",
    "validate_device_model",
    "validate_device_type",
    "validate_email",
    "validate_file_selection",
    "validate_problem_description",
    "validate_problem_started_at",
    "validate_serial_number",
    "validate_service_centre",
    "validate_submit_confirmation",
    "validate_upload",
    "validate_urgency",
    "words",
]
