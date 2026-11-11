// Fake but well-formed configuration values. None of these is a real credential.
export const FAKE = {
  DEEPGRAM_API_KEY: "fake-deepgram-key-0000000000",
  GROQ_API_KEY: "fake-groq-key-000000000000000",
  GEMINI_API_KEY: "fake-gemini-key-0000000000000",
  DATABASE_URL: "postgresql://fakeuser:fake-db-password-000@db.invalid/app?sslmode=require",
  FILE_URL_SECRET: "fake-file-url-secret-00000000000000",
  HOOK_SECRET: "fake-hook-secret-0000000000000000000",
  TEST_API_TOKEN: "fake-test-api-token-0000000",
  QUOTA_OVERRIDE_TOKEN: "fake-quota-override-token-000",
} as const;

/** Every fake secret value above, for the sanitization oracle (none may appear in a record or an API response). */
export const FAKE_SECRET_VALUES: readonly string[] = Object.values(FAKE);

export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PUBLIC_ORIGIN: "http://localhost:8080",
    DEEPGRAM_API_KEY: FAKE.DEEPGRAM_API_KEY,
    GROQ_API_KEY: FAKE.GROQ_API_KEY,
    DATABASE_URL: FAKE.DATABASE_URL,
    FILE_URL_SECRET: FAKE.FILE_URL_SECRET,
    HOOK_SECRET: FAKE.HOOK_SECRET,
    ...overrides,
  };
}
