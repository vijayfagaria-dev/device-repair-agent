"""Config fixtures: the fake secrets (shared with tests/helpers/fake.py) and a complete valid environment."""

from __future__ import annotations

from tests.helpers.fake import FAKE, FAKE_SECRET_VALUES

__all__ = ["FAKE", "FAKE_SECRET_VALUES", "valid_env"]


def valid_env(**overrides: str | None) -> dict[str, str | None]:
    """A complete valid environment; an override of `None` removes the variable."""
    env: dict[str, str | None] = {
        "PUBLIC_ORIGIN": "http://localhost:8080",
        "DEEPGRAM_API_KEY": FAKE["DEEPGRAM_API_KEY"],
        "GROQ_API_KEY": FAKE["GROQ_API_KEY"],
        "DATABASE_URL": FAKE["DATABASE_URL"],
        "FILE_URL_SECRET": FAKE["FILE_URL_SECRET"],
        "HOOK_SECRET": FAKE["HOOK_SECRET"],
    }
    env.update(overrides)
    return env
