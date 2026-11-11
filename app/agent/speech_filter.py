"""Cleans the model's streamed text before it is spoken or recorded.

Real gpt-oss-20b calls leaked prompt markup (``<customer_words field="deviceModel">``), emitted runs of zero-width
characters, whitespace and ellipses for seconds, and glued sentences together ("chat.When"). This is stateful because
markup and sentences span deltas.
"""

from __future__ import annotations

import re

from app.domain.fields import FIELDS, RECORD_FIELD_IDS

#: Internal names the model must never say aloud: field ids become their spoken label, state keys vanish.
_FIELD_NAMES: dict[str, str] = {
    **{field_id: FIELDS[field_id].label for field_id in RECORD_FIELD_IDS},
    "submitConfirmation": "confirmation",
    "optOutConfirmation": "confirmation",
}
_STATE_KEYS = [
    "heardButMustBeTyped",
    "pendingChatCards",
    "readyToSubmit",
    "claimStatus",
    "isReturningCall",
    "newChatEvents",
    "givenUp",
    "callSecondsElapsed",
    "lastQuestionOnPreviousCall",
    "localTime",
    "request_chat_input",
    "save_field",
    "flag_for_review",
    "opt_out",
    "end_call",
    "spoken_evidence",
    "user_confirmed",
]
_INTERNAL = re.compile(r"\b(?:" + "|".join([*_FIELD_NAMES, *_STATE_KEYS]) + r")\b")
_MANY_SPACES = re.compile(r" {2,}")


def _hide_internal(text: str) -> str:
    return _MANY_SPACES.sub(" ", _INTERNAL.sub(lambda m: _FIELD_NAMES.get(m.group(0), ""), text))


#: Zero-width and bidi-control characters: never meaningful in speech.
_INVISIBLE = re.compile("[​-‏⁠-⁤‪-‮﻿­]")
#: Markdown emphasis and code marks: a voice reads "**Yes**" as "star star yes".
_MARKDOWN = re.compile(r"[*`]+|~~")
#: A tag that was not closed within this many characters is plain text, not markup.
MAX_TAG = 160
#: Consecutive filler (whitespace, dots, ellipses) beyond this means the model is looping.
MAX_JUNK_RUN = 12

_WORD_TAIL = re.compile(r"[A-Za-z0-9_]+$")
_FILLER = re.compile(r"[\s.…]")
_SPACE = re.compile(r"\s")
_UPPER = re.compile(r"[A-Z]")
_SENTENCE_END = re.compile(r"[.!?]")
_TRAILING_DOTS = re.compile(r"\.*$")


class SpeechFilter:
    def __init__(self) -> None:
        self._pending_tag = ""
        #: The unfinished last word of the previous delta: held until the next one so a name split in two is still seen.
        self._word = ""
        self._last_char = ""
        self._last_non_space = ""
        self._junk_run = 0
        #: The model is producing runaway filler: the caller should stop reading the stream.
        self.degenerate = False

    def push(self, delta: str) -> str:
        """Cleaned text for one streamed delta ("" while it is inside a tag or only filler)."""
        text = _MARKDOWN.sub("", _INVISIBLE.sub("", delta))
        value = self._pending_tag + self._word + text
        self._word = ""
        self._pending_tag = ""
        out = ""
        while value:
            open_at = value.find("<")
            if open_at == -1:
                out += value
                break
            out += value[:open_at]
            close = value.find(">", open_at)
            if close == -1:
                rest = value[open_at:]
                if len(rest) > MAX_TAG:
                    out += rest.replace("<", " ", 1)
                else:
                    self._pending_tag = rest  # possibly the start of a tag; wait for more
                break
            value = value[close + 1 :]
        match = _WORD_TAIL.search(out)
        tail = match.group(0) if match else ""
        self._word = tail
        return _hide_internal(self._tidy(out[: len(out) - len(tail)]))

    def flush(self) -> str:
        """What is left at the end of the stream (an unfinished tag is dropped)."""
        self._pending_tag = ""
        word = self._word
        self._word = ""
        return _hide_internal(self._tidy(word)) if word else ""

    @staticmethod
    def _dots_run(text: str) -> int:
        match = _TRAILING_DOTS.search(text)
        return len(match.group(0)) if match else 0

    def _tidy(self, text: str) -> str:
        result = ""
        for ch in text:
            if _FILLER.match(ch):
                self._junk_run += 1
                if self._junk_run > MAX_JUNK_RUN:
                    self.degenerate = True
            else:
                self._junk_run = 0
            prev = result[-1] if result else self._last_char
            # Whitespace runs become one space; ellipsis runs become one.
            if _SPACE.match(ch):
                if prev == "" or _SPACE.match(prev):
                    continue
                result += " "
                continue
            if ch in ("…", "."):
                tail = result.rstrip()
                before = tail[-1] if tail else self._last_non_space
                # An ellipsis never follows another dot or ellipsis (even across a space); a plain "." run stops at three.
                if before == "…" or (
                    before == "."
                    and (ch == "…" or len(result) != len(tail) or tail.endswith("...") or self._dots_run(result) >= 3)
                ):
                    continue
            # "chat.When" -> "chat. When"
            if (
                _UPPER.match(ch) and _SENTENCE_END.match(prev) and len(result) > 1 and not _UPPER.match(result[-2])
            ) or (_UPPER.match(ch) and _SENTENCE_END.match(prev) and len(result) == 0 and self._last_char != ""):
                result += " "
            result += ch
        if result:
            self._last_char = result[-1]
        visible = result.rstrip()
        if visible:
            self._last_non_space = visible[-1]
        return result


def clean_speech(text: str) -> str:
    """One-shot cleaning (tests and non-streaming uses)."""
    speech_filter = SpeechFilter()
    return (speech_filter.push(text) + speech_filter.flush()).strip()
