"""Fake but well-formed configuration values (port of server/test/fixtures.ts). None of these is a real credential."""

from __future__ import annotations

FAKE = {
    "DEEPGRAM_API_KEY": "fake-deepgram-key-0000000000",
    "GROQ_API_KEY": "fake-groq-key-000000000000000",
    "GEMINI_API_KEY": "fake-gemini-key-0000000000000",
    "DATABASE_URL": "postgresql://fakeuser:fake-db-password-000@db.invalid/app?sslmode=require",
    "FILE_URL_SECRET": "fake-file-url-secret-00000000000000",
    "HOOK_SECRET": "fake-hook-secret-0000000000000000000",
    "TEST_API_TOKEN": "fake-test-api-token-0000000",
    "QUOTA_OVERRIDE_TOKEN": "fake-quota-override-token-000",
}

#: Every fake secret value above, for the sanitization oracle (none may appear in a record or an API response).
FAKE_SECRET_VALUES: list[str] = list(FAKE.values())
