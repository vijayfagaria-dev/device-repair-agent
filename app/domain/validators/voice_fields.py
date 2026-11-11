"""Validators for the fields collected on the call (D14, P2-T02). The LLM proposes values through save_field; these
decide. Inputs are the tool's arguments (a string, or a dict with the model's normalized guess plus the user's words)
or a chat fallback card's answer. Every `error` is one short sentence the agent can say."""

from __future__ import annotations

import re
from typing import Any

from ..dates import CivilDate, add_months, is_civil_date
from ..fields import (
    DEVICE_TYPES,
    URGENCY_LEVELS,
    DeviceModelValue,
    ProblemDescriptionValue,
    ProblemStartedAtValue,
    UrgencyValue,
)
from .result import ValidationResult, invalid, valid
from .spoken_date import is_unknown_date_phrase, resolve_spoken_date
from .strings import char_length, clean_text, has_phrase, phrase_starts, truncate, words


def _string_field(value: Any, key: str) -> str | None:
    field = value.get(key) if isinstance(value, dict) else None
    return field if isinstance(field, str) else None


_UNKNOWN_ANSWER = re.compile(
    r"\b(?:dont know|do not know|not sure|no idea|unknown|cant remember|dont remember|no clue)\b", re.ASCII
)


def _is_unknown_answer(text: str) -> bool:
    return _UNKNOWN_ANSWER.search(" ".join(words(text))) is not None


# ---------------------------------------------------------------------------------------------------------------------
# deviceType

# Checked in this order, so "galaxy watch" is a smartwatch and "galaxy tab" a tablet, not a phone.
DEVICE_TYPE_PHRASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "headphones",
        (
            "headphones",
            "headphone",
            "earphones",
            "earphone",
            "earbuds",
            "earbud",
            "airpods",
            "headset",
            "buds",
            "neckband",
        ),
    ),
    ("smartwatch", ("smartwatch", "smart watch", "watch", "fitness band", "fitbit")),
    ("tablet", ("tablet", "ipad", "tab")),
    ("laptop", ("laptop", "notebook", "macbook", "chromebook", "ultrabook", "thinkpad")),
    (
        "smartphone",
        ("smartphone", "phone", "mobile", "cellphone", "iphone", "android", "galaxy", "pixel", "handset"),
    ),
    (
        "other",
        ("other", "something else", "desktop", "camera", "speaker", "console", "tv", "television", "printer", "kindle"),
    ),
)


def validate_device_type(raw: Any) -> ValidationResult[str]:
    ask = "Sorry, what kind of device is it: a phone, laptop, tablet, smartwatch or headphones?"
    if not isinstance(raw, str):
        return invalid(ask)
    exact = clean_text(raw).lower()
    if exact in DEVICE_TYPES:
        return valid(exact)
    tokens = words(raw)
    for device_type, phrases in DEVICE_TYPE_PHRASES:
        if any(has_phrase(tokens, phrase) for phrase in phrases):
            return valid(device_type)
    return invalid(ask)


# ---------------------------------------------------------------------------------------------------------------------
# deviceModel

# Canonical brand names, keyed by the words that identify them (D14: brand canonicalized from an alias list).
BRANDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Apple", ("apple", "iphone", "ipad", "macbook", "imac", "airpods")),
    ("Samsung", ("samsung", "galaxy")),
    ("Google", ("google", "pixel", "fitbit")),
    ("OnePlus", ("oneplus", "one plus")),
    ("Xiaomi", ("xiaomi", "redmi", "poco")),
    ("OPPO", ("oppo",)),
    ("vivo", ("vivo",)),
    ("realme", ("realme",)),
    ("Motorola", ("motorola", "moto")),
    ("Nokia", ("nokia",)),
    ("Sony", ("sony", "xperia")),
    ("Dell", ("dell", "xps", "inspiron", "alienware")),
    ("HP", ("hp", "pavilion", "elitebook", "hewlett packard")),
    ("Lenovo", ("lenovo", "thinkpad", "ideapad")),
    ("ASUS", ("asus", "zenbook", "vivobook")),
    ("Acer", ("acer", "aspire")),
    ("Microsoft", ("microsoft", "surface")),
    ("Huawei", ("huawei",)),
    ("Honor", ("honor",)),
    ("LG", ("lg",)),
    ("boAt", ("boat",)),
    ("JBL", ("jbl",)),
    ("Bose", ("bose",)),
    ("Sennheiser", ("sennheiser",)),
    ("Garmin", ("garmin",)),
)


def detect_brand(text: str) -> str | None:
    tokens = words(text)
    for brand, aliases in BRANDS:
        if any(has_phrase(tokens, alias) for alias in aliases):
            return brand
    return None


def validate_device_model(raw: Any, *, allow_unknown: bool = False) -> ValidationResult[DeviceModelValue]:
    """Brand and model: "iPhone 14 Pro" -> {brand: "Apple", model: "iPhone 14 Pro"}.

    `allow_unknown`: after one re-ask, "I don't know" is accepted as unknown (D14); the controller tracks the attempt."""
    ask = "Which brand and model is it? For example, Samsung Galaxy S23."
    if isinstance(raw, str):
        joined = raw
    else:
        joined = " ".join(p for p in (_string_field(raw, "brand"), _string_field(raw, "model")) if p)
    text = clean_text(joined)
    if text == "":
        return invalid(ask)
    if _is_unknown_answer(text):
        # "It's a Samsung, not sure which model": the brand is what they know, the same as answering just "Samsung".
        known_brand = detect_brand(text)
        if known_brand:
            return valid({"brand": known_brand, "model": None})
        if allow_unknown:
            return valid({"brand": None, "model": None})
        return invalid("No problem. Could you check the box, the label, or Settings, About? Even just the brand helps.")
    if char_length(text) < 2 or char_length(text) > 80 or not any(c.isalpha() for c in text):
        return invalid(ask)
    brand = detect_brand(text)
    # The model is what was said, minus a leading brand name ("Samsung Galaxy S23" -> "Galaxy S23"); product-line
    # words stay ("iPhone 14 Pro" keeps "iPhone").
    if brand == "OnePlus":
        leading_brand: re.Pattern[str] | None = re.compile(r"^one ?plus(?:\s+|$)", re.IGNORECASE)
    elif brand:
        leading_brand = re.compile(rf"^{re.escape(brand)}(?:\s+|$)", re.IGNORECASE)
    else:
        leading_brand = None
    model = leading_brand.sub("", text, count=1).strip() if leading_brand else text
    return valid({"brand": brand, "model": None if model == "" else model})


# ---------------------------------------------------------------------------------------------------------------------
# problemDescription

_FILLERS = frozenset(
    [
        "um",
        "uh",
        "er",
        "erm",
        "hmm",
        "like",
        "so",
        "well",
        "basically",
        "actually",
        "okay",
        "ok",
        "yeah",
        "yes",
        "you",
        "know",
        "mean",
    ]
)
# Words that don't describe a symptom by themselves: "it's broken", "my phone is not working".
_VAGUE = frozenset(
    [
        "a", "an", "the", "it", "its", "is", "was", "are", "my", "this", "that", "has", "have", "been", "just", "i",
        "me", "not", "isnt", "doesnt", "dont", "very", "really", "some", "there", "and", "or", "of", "to", "at", "in",
        "on", "broken", "working", "work", "works", "problem", "problems", "issue", "issues", "bad", "damaged",
        "faulty", "wrong", "properly", "anymore", "thing", "stuff", "device", "phone", "laptop", "tablet", "watch",
        "headphones",
    ]
)  # fmt: skip
MAX_SUMMARY_CHARS = 300
MAX_VERBATIM_CHARS = 1000


def validate_problem_description(raw: Any) -> ValidationResult[ProblemDescriptionValue]:
    """At least three non-filler words, at least one of which describes something specific (D14)."""
    probe = "Could you tell me a bit more about what's wrong? For example, what happens when you use it?"
    if isinstance(raw, str):
        verbatim_raw: str | None = raw
    else:
        verbatim_raw = _string_field(raw, "verbatim")
        if verbatim_raw is None:
            verbatim_raw = _string_field(raw, "summary")
    if verbatim_raw is None:
        return invalid(probe)
    verbatim = truncate(clean_text(verbatim_raw), MAX_VERBATIM_CHARS)
    content = [w for w in words(verbatim) if w not in _FILLERS]
    if len(content) < 3 or all(w in _VAGUE for w in content):
        return invalid(probe)
    summary_raw = None if isinstance(raw, str) else _string_field(raw, "summary")
    summary = truncate(
        clean_text(summary_raw) if summary_raw and clean_text(summary_raw) != "" else verbatim, MAX_SUMMARY_CHARS
    )
    return valid({"summary": summary, "verbatim": verbatim})


# ---------------------------------------------------------------------------------------------------------------------
# problemStartedAt

MAX_PROBLEM_AGE_YEARS = 10


def validate_problem_started_at(raw: Any, *, today: CivilDate) -> ValidationResult[ProblemStartedAtValue]:
    """When the problem started. The user's words are resolved in code (P0-T03). Input: the spoken phrase (string or
    `{"spoken": ...}`), or a YYYY-MM-DD from the chat date card (or `{"date": ...}` with no phrase). When a phrase is
    given, the model's own `date` is ignored: if the phrase can't be resolved, the agent asks again rather than
    trusting it. `today` is the session's current date in IST (from the server clock)."""
    spoken = raw if isinstance(raw, str) else _string_field(raw, "spoken")
    model_date = _string_field(raw, "date")
    phrase: str | None = None

    if spoken is not None and clean_text(spoken) != "":
        phrase = clean_text(spoken)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", phrase, re.ASCII) and not is_civil_date(phrase):
            return invalid("Please choose a valid date.")
        if is_civil_date(phrase):
            date, precision = phrase, "day"
            phrase = None if isinstance(raw, str) else phrase
        else:
            if is_unknown_date_phrase(phrase):
                return invalid("No problem. Roughly when did it start: a few days ago, last week, or a month ago?")
            resolved = resolve_spoken_date(phrase, today)
            if not resolved:
                return invalid("Roughly which date was that? For example, last Tuesday, or the 3rd of November.")
            date, precision = resolved.date, resolved.precision
    elif model_date is not None and is_civil_date(clean_text(model_date)):
        date, precision = clean_text(model_date), "day"
    else:
        return invalid("Please choose a valid date.")

    if date > today:
        return invalid("That date is in the future. When did the problem start?")
    if date < add_months(today, -12 * MAX_PROBLEM_AGE_YEARS):
        return invalid(f"That's more than {MAX_PROBLEM_AGE_YEARS} years ago. When did the problem start?")
    return valid({"date": date, "precision": precision, "spoken": phrase})


# ---------------------------------------------------------------------------------------------------------------------
# urgency

# Checked in this order: the "low" phrases (which are themselves negations, "not urgent") first, then the strongest
# level that matches. Bare level words ("low", "high") aren't phrases: "the battery is low" says nothing about urgency.
URGENCY_PHRASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "low",
        (
            "no rush", "no hurry", "not urgent", "not really urgent", "not in a hurry", "whenever", "take your time",
            "no pressure", "not important", "not a priority", "can wait", "low priority",
        ),
    ),
    (
        "critical",
        (
            "critical", "emergency", "immediately", "right now", "right away", "medical", "cant manage without",
            "cant live without", "cant work at all",
        ),
    ),
    (
        "high",
        (
            "urgent", "urgently", "asap", "as soon as possible", "quickly", "soon", "tomorrow", "today", "for work",
            "important", "high priority", "fast",
        ),
    ),
    (
        "normal",
        (
            "normal", "few days", "this week", "next week", "within a week", "regular", "standard", "medium",
            "moderate", "no particular",
        ),
    ),
)  # fmt: skip
# A level phrase within three words after one of these is negated ("not an emergency", "don't need it right away").
_NEGATIONS = frozenset(["not", "dont", "doesnt", "isnt", "wont", "never"])
_NEGATION_WINDOW = 3
MAX_URGENCY_REASON_CHARS = 200


def _is_affirmed(tokens: list[str], phrase: str) -> bool:
    return any(
        not any(word in _NEGATIONS for word in tokens[max(0, start - _NEGATION_WINDOW) : start])
        for start in phrase_starts(tokens, phrase)
    )


def validate_urgency(raw: Any) -> ValidationResult[UrgencyValue]:
    ask = "How soon do you need it back: no rush, within a few days, urgently, or immediately?"
    level_text = raw if isinstance(raw, str) else _string_field(raw, "level")
    reason_text = None if isinstance(raw, str) else _string_field(raw, "reason")

    def reason(text: str | None) -> str | None:
        cleaned = "" if text is None else truncate(clean_text(text), MAX_URGENCY_REASON_CHARS)
        return None if cleaned == "" or cleaned.lower() in URGENCY_LEVELS else cleaned

    exact = "" if level_text is None else clean_text(level_text).lower()
    if exact in URGENCY_LEVELS:
        return valid({"level": exact, "reason": reason(reason_text)})

    said = " ".join(text for text in (level_text, reason_text) if text is not None)
    tokens = words(said)
    for level, phrases in URGENCY_PHRASES:
        matched = (
            any(has_phrase(tokens, p) for p in phrases)
            if level == "low"
            else any(_is_affirmed(tokens, p) for p in phrases)
        )
        if matched:
            return valid({"level": level, "reason": reason(reason_text if reason_text is not None else level_text)})
    # Nothing matched, or only negated phrases ("it's not an emergency"): ask rather than guess.
    return invalid(ask)
