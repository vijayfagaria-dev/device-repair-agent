"""Grounding for save_field.

A value is only saved when the evidence the model quotes was really said by the customer in their recent utterances.
Real calls showed gpt-oss-20b saving values nobody had said yet (urgency "critical" with an invented quote, a problem
description before the customer described anything, "...??" as a description).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

_NON_WORD = re.compile(r"[^\w]+|_+", re.UNICODE)
_HAS_LETTER_OR_DIGIT = re.compile(r"[^\W_]", re.UNICODE)

#: How many of the customer's most recent utterances count (the one just spoken, and a little context).
RECENT_UTTERANCES = 4
MIN_GROUNDED_SHARE = 0.7


def _normalize(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKC", text).lower().replace("\u2019", "").replace("'", "")
    return [word for word in _NON_WORD.sub(" ", folded).strip().split(" ") if word]


def grounded_share(evidence: str, utterances: Sequence[str]) -> float:
    """Share of the evidence's words that appear, as words, in what the customer said."""
    words = _normalize(evidence)
    if not words:
        return 0
    said = {word for utterance in utterances for word in _normalize(utterance)}
    return sum(1 for word in words if word in said) / len(words)


def grounding_error(evidence: str, utterances: Sequence[str]) -> str | None:
    """None when the evidence is grounded; otherwise the error the model is told."""
    if not _HAS_LETTER_OR_DIGIT.search(evidence):
        return "spoken_evidence must be the customer's exact words; save only what they actually said"
    recent = list(utterances)[-RECENT_UTTERANCES:]
    if grounded_share(evidence, recent) >= MIN_GROUNDED_SHARE:
        return None
    return "the customer has not said that. Save a field only from their own recent words, quoted exactly in spoken_evidence; ask them instead"
