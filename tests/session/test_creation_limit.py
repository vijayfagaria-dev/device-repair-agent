from __future__ import annotations

import pytest

from app.session.creation_limit import CreationLimiter


class Clock:
    def __init__(self, start: float = 1_000_000) -> None:
        self._now = start

    def now(self) -> float:
        return self._now

    def advance(self, ms: float) -> None:
        self._now += ms


class TestCreationLimiter:
    def test_allows_max_acquisitions_per_key_per_window_then_refuses_without_consuming(self) -> None:
        time = Clock()
        limiter = CreationLimiter(max=3, window_ms=1000, now=time.now)
        assert [limiter.try_acquire("a") for _ in (1, 2, 3)] == [True, True, True]
        assert limiter.try_acquire("a") is False
        assert limiter.try_acquire("a") is False
        assert limiter.try_acquire("b") is True

    def test_is_a_sliding_window_each_slot_frees_exactly_window_ms_after_it_was_taken(self) -> None:
        time = Clock()
        limiter = CreationLimiter(max=2, window_ms=1000, now=time.now)
        limiter.try_acquire("a")
        time.advance(400)
        limiter.try_acquire("a")
        assert limiter.try_acquire("a") is False
        time.advance(599)  # 999 ms after the first
        assert limiter.try_acquire("a") is False
        time.advance(1)  # the first slot has expired; the second is still live
        assert limiter.try_acquire("a") is True
        assert limiter.try_acquire("a") is False

    def test_release_gives_a_slot_back(self) -> None:
        limiter = CreationLimiter(max=1, window_ms=1000)
        assert limiter.try_acquire("a") is True
        limiter.release("a")
        assert limiter.try_acquire("a") is True
        assert limiter.try_acquire("a") is False
        limiter.release("unknown")  # harmless

    def test_forgets_idle_keys_so_memory_is_bounded_by_the_keys_active_in_one_window(self) -> None:
        time = Clock()
        limiter = CreationLimiter(max=5, window_ms=1000, now=time.now)
        for i in range(100):
            limiter.try_acquire(f"ip-{i}")
        assert limiter.size == 100
        time.advance(1000)
        limiter.try_acquire("fresh")
        assert limiter.size == 1

    def test_rejects_invalid_settings(self) -> None:
        with pytest.raises(ValueError):
            CreationLimiter(max=0, window_ms=1000)
        with pytest.raises(ValueError):
            CreationLimiter(max=1.5, window_ms=1000)  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            CreationLimiter(max=1, window_ms=0)
