"""String hygiene shared by every validator and the record builder (D14 "common to all strings"; architecture section 7
step 1): Unicode normalization, control and invisible formatting characters removed, whitespace collapsed."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Literal

# C0/C1 controls except tab, newline and carriage return, zero-width and bidirectional formatting characters
# (spoofing), and the invisible Unicode tag characters (U+E0000 to U+E007F) and supplementary variation selectors
# (U+E0100 to U+E01EF). Those last two can carry hidden text that a person never sees but a language model reads
# (prompt-injection smuggling).
_UNSAFE_CHARS = re.compile(
    r"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤"
    r"⁦-⁩﻿\U000E0000-\U000E007F\U000E0100-\U000E01EF]"
)
_WHITESPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[\W_]+")  # runs of anything that is not a letter or digit (JS: [^\p{L}\p{N}]+)


def clean_text(raw: str, *, form: Literal["NFC", "NFKC"] = "NFC", multiline: bool = False) -> str:
    """Normalizes, strips unsafe characters, collapses whitespace and trims. Never raises.

    `form`: NFKC for identifiers (full-width digits become ASCII); NFC elsewhere (keeps the user's characters).
    `multiline`: keep line breaks (collapsing other whitespace); for free text such as notes."""
    text = _UNSAFE_CHARS.sub("", unicodedata.normalize(form, raw))
    if not multiline:
        return _WHITESPACE.sub(" ", text).strip()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(_WHITESPACE.sub(" ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def char_length(text: str) -> int:
    """Length in user-perceived characters (code points), so emoji and Indic text aren't over-counted."""
    return len(text)


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def truncate(text: str, max_chars: int) -> str:
    """Cuts to at most `max_chars` code points, at a word boundary when one is reasonably close."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    if re.match(r"\s", text[max_chars]):
        return cut.rstrip()  # already ends on a word boundary
    space = cut.rfind(" ")
    # JS indexes by UTF-16 code unit, so the "reasonably close" test uses the UTF-16 position of the space.
    if space >= 0 and _utf16_len(cut[:space]) > max_chars * 0.6:
        return cut[:space].rstrip()
    return cut.rstrip()


def words(text: str) -> list[str]:
    """Lowercase words of a cleaned phrase (letters and digits), for matching against synonym lists."""
    cleaned = clean_text(text, form="NFKC").lower().replace("’", "").replace("'", "")  # noqa: RUF001
    return [w for w in _NON_WORD.split(cleaned) if w]


def phrase_starts(tokens: Sequence[str], phrase: str) -> list[int]:
    """Where `phrase` occurs as whole words in `tokens` (the index of its first word), in order."""
    target = phrase.split(" ")
    return [
        i for i in range(len(tokens) - len(target) + 1) if all(tokens[i + j] == word for j, word in enumerate(target))
    ]


def has_phrase(tokens: Sequence[str], phrase: str) -> bool:
    """True when the tokens contain `phrase` as whole words ("not urgent" in "it's not urgent at all")."""
    return len(phrase_starts(tokens, phrase)) > 0
