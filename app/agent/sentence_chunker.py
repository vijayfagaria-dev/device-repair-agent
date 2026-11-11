"""Splits streamed agent text into speakable chunks (P5-T11).

At sentence ends (. ? !) followed by a space, except after common abbreviations and inside numbers (3.5, 1.2 s), or at a
comma once a chunk is long (120 chars), so TTS starts early without breaking mid-sentence.
"""

from __future__ import annotations

import re

ABBREVIATIONS = frozenset(
    ["mr", "mrs", "ms", "dr", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "approx", "no", "nos", "mt", "ft"]
)
LONG_CHUNK_CHARS = 120

_BEFORE = re.compile(r"([A-Za-z.]+)$")
_SPACE = re.compile(r"\s")


class SentenceChunker:
    def __init__(self) -> None:
        self._buffer = ""

    def push(self, delta: str) -> list[str]:
        """Adds streamed text; returns the chunks it completed."""
        self._buffer += delta
        chunks: list[str] = []
        while True:
            cut = self._find_cut()
            if cut < 0:
                break
            chunk = self._buffer[:cut].strip()
            self._buffer = self._buffer[cut:].lstrip()
            if chunk:
                chunks.append(chunk)
        return chunks

    def flush(self) -> list[str]:
        """The rest, at the end of the turn."""
        rest = self._buffer.strip()
        self._buffer = ""
        return [rest] if rest else []

    def _find_cut(self) -> int:
        text = self._buffer
        for i in range(len(text) - 1):
            ch = text[i]
            if ch in ".?!" and _SPACE.match(text[i + 1]):
                if ch == "." and self._is_abbreviation(text, i):
                    continue
                return i + 1
        if len(text) >= LONG_CHUNK_CHARS:
            comma = text.rfind(", ", 0, LONG_CHUNK_CHARS + 2)
            if comma > 20:
                return comma + 1
        return -1

    @staticmethod
    def _is_abbreviation(text: str, dot: int) -> bool:
        match = _BEFORE.search(text[:dot])
        before = match.group(1).lower() if match else ""
        if before in ABBREVIATIONS:
            return True
        # A single capital letter ("A. Rao") is an initial.
        return (
            re.fullmatch(r"[a-z]", before) is not None
            and re.search(r"[A-Z]", text[dot - 1] if dot >= 1 else "") is not None
        )
