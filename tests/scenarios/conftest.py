"""The full-session rig: a real server with fake providers over a fresh schema per test."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from tests.scenarios.driver import Rig


@pytest.fixture
async def rig(test_database_url: str) -> AsyncIterator[Rig]:
    created = await Rig.create(test_database_url)
    try:
        yield created
    finally:
        await created.close()
