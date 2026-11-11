"""Per-key sliding-window limit on new session creation (P1-T03; protocol.md section 2: default 20 per IP per hour).

In memory and per process: one Render instance runs at a time (D11), and a restart only resets the budget.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable


def _now_ms() -> float:
    return time.time() * 1000


class CreationLimiter:
    def __init__(self, *, max: int, window_ms: float, now: Callable[[], float] | None = None) -> None:
        if not isinstance(max, int) or isinstance(max, bool) or max < 1:
            raise ValueError("max must be a positive integer")
        if not math.isfinite(window_ms) or window_ms <= 0:
            raise ValueError("window_ms must be positive")
        self._max = max
        self._window_ms = window_ms
        self._now = now or _now_ms
        # Creation times per key, oldest first, at most `max` entries each.
        self._hits: dict[str, list[float]] = {}
        self._last_sweep = 0.0

    def try_acquire(self, key: str) -> bool:
        """Takes one slot for `key`. Returns False (and takes nothing) when the key has used its budget for the window."""
        now = self._now()
        self._sweep(now)
        hits = self._live(key, now)
        if len(hits) >= self._max:
            return False
        hits.append(now)
        self._hits[key] = hits
        return True

    def release(self, key: str) -> None:
        """Gives back the most recent slot, when the acquire didn't end up creating anything."""
        hits = self._hits.get(key)
        if hits is None:
            return
        if hits:
            hits.pop()
        if not hits:
            del self._hits[key]

    @property
    def size(self) -> int:
        """Number of keys currently tracked (for tests)."""
        return len(self._hits)

    def _live(self, key: str, now: float) -> list[float]:
        hits = self._hits.get(key, [])
        first_live = next((i for i, at in enumerate(hits) if now - at < self._window_ms), -1)
        if first_live == -1:
            return []
        return hits if first_live == 0 else hits[first_live:]

    def _sweep(self, now: float) -> None:
        """Drops expired keys at most once per window, so memory stays bounded by the keys active in one window."""
        if now - self._last_sweep < self._window_ms:
            return
        self._last_sweep = now
        for key in [k for k, hits in self._hits.items() if not hits or now - hits[-1] >= self._window_ms]:
            del self._hits[key]
