import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, Secret } from "../src/config.js";
import { FAKE, validEnv } from "./fixtures.js";

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("accepts a valid environment and applies defaults", () => {
    const config = loadConfig(validEnv());
    expect(config).toMatchObject({ env: "development", host: "0.0.0.0", port: 8080, logLevel: "info" });
    expect(config.publicOrigin).toBe("http://localhost:8080");
    expect(config.groqApiKey.reveal()).toBe(FAKE.GROQ_API_KEY);
    expect(config.databaseUrl.reveal()).toBe(FAKE.DATABASE_URL);
    expect(config.geminiApiKey).toBeNull();
    expect(config.testApiToken).toBeNull();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("parses optional and typed values", () => {
    const config = loadConfig(
      validEnv({
        PORT: "3001",
        LOG_LEVEL: "debug",
        GEMINI_API_KEY: FAKE.GEMINI_API_KEY,
        ALLOW_TEST_API: "true",
        TEST_API_TOKEN: FAKE.TEST_API_TOKEN,
      }),
    );
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe("debug");
    expect(config.geminiApiKey?.reveal()).toBe(FAKE.GEMINI_API_KEY);
    expect(config.testApiToken?.reveal()).toBe(FAKE.TEST_API_TOKEN);
  });

  it("defaults and parses the proxy-trust and new-session limits (P1-T03)", () => {
    expect(loadConfig(validEnv())).toMatchObject({ trustProxyHops: 0, newSessionsPerIpPerHour: 20 });
    expect(loadConfig(validEnv({ TRUST_PROXY_HOPS: "1", NEW_SESSIONS_PER_IP_PER_HOUR: "50" }))).toMatchObject({
      trustProxyHops: 1,
      newSessionsPerIpPerHour: 50,
    });
    const err = configError(validEnv({ TRUST_PROXY_HOPS: "-1", NEW_SESSIONS_PER_IP_PER_HOUR: "0" }));
    expect(err.problems).toEqual([
      { name: "TRUST_PROXY_HOPS", problem: "is invalid (expected an integer from 0 to 5)" },
      { name: "NEW_SESSIONS_PER_IP_PER_HOUR", problem: "is invalid (expected an integer from 1 to 10000)" },
    ]);
    for (const bad of ["1.5", "abc", "999"]) {
      const message = configError(validEnv({ TRUST_PROXY_HOPS: bad })).message;
      expect(message).toContain("TRUST_PROXY_HOPS is invalid");
      expect(message).not.toContain(bad);
    }
  });

  it("names every missing variable at once, treating blank values as missing", () => {
    const err = configError(validEnv({ GROQ_API_KEY: undefined, HOOK_SECRET: "   ", PUBLIC_ORIGIN: "" }));
    expect(err.problems).toEqual(
      expect.arrayContaining([
        { name: "GROQ_API_KEY", problem: "is missing" },
        { name: "HOOK_SECRET", problem: "is missing" },
        { name: "PUBLIC_ORIGIN", problem: "is missing" },
      ]),
    );
    expect(err.problems).toHaveLength(3);
    expect(err.message).toContain("GROQ_API_KEY is missing");
  });

  it("never includes a value in the error, valid or invalid", () => {
    const invalid = {
      DEEPGRAM_API_KEY: "short-dg-key",
      FILE_URL_SECRET: "too-short-file-secret",
      DATABASE_URL: "mysql://someone:hunter2-password@db.invalid/app",
      PUBLIC_ORIGIN: "https://example.com/some/path",
      PORT: "not-a-port-9999",
      LOG_LEVEL: "loud-level",
      TEST_API_TOKEN: "tiny-token",
    };
    const err = configError(validEnv({ ...invalid, GROQ_API_KEY: undefined }));
    const names = err.problems.map((p) => p.name).sort();
    expect(names).toEqual([...Object.keys(invalid), "GROQ_API_KEY"].sort());
    const output = `${err.message}\n${JSON.stringify(err.problems)}\n${inspect(err)}`;
    for (const value of [...Object.values(invalid), ...Object.values(FAKE)]) {
      expect(output).not.toContain(value);
    }
    expect(output).not.toContain("hunter2");
  });

  it("requires TEST_API_TOKEN only when the test API is enabled", () => {
    expect(loadConfig(validEnv({ ALLOW_TEST_API: "false" })).testApiToken).toBeNull();
    const err = configError(validEnv({ ALLOW_TEST_API: "true" }));
    expect(err.problems).toEqual([{ name: "TEST_API_TOKEN", problem: "is missing (required when ALLOW_TEST_API=true)" }]);
  });

  it("requires an https PUBLIC_ORIGIN in production", () => {
    const err = configError(validEnv({ NODE_ENV: "production" }));
    expect(err.problems).toEqual([{ name: "PUBLIC_ORIGIN", problem: "is invalid (must use https in production)" }]);
    expect(loadConfig(validEnv({ NODE_ENV: "production", PUBLIC_ORIGIN: "https://repair.example.com" })).env).toBe("production");
  });
});

describe("P7: record delivery and idle completion", () => {
  it("defaults: AUTO_COMPLETE_ON_IDLE on, no webhook (the built-in stub receiver)", () => {
    expect(loadConfig(validEnv())).toMatchObject({ autoCompleteOnIdle: true, recordWebhookUrl: null });
    expect(loadConfig(validEnv({ AUTO_COMPLETE_ON_IDLE: "false" })).autoCompleteOnIdle).toBe(false);
  });

  it("RECORD_WEBHOOK_URL must be http(s) and is a Secret (a request-bin URL can be the credential)", () => {
    const config = loadConfig(validEnv({ RECORD_WEBHOOK_URL: "https://hooks.example.com/abc123secret" }));
    expect(config.recordWebhookUrl?.reveal()).toBe("https://hooks.example.com/abc123secret");
    expect(JSON.stringify(config)).not.toContain("abc123secret");
    for (const bad of ["ftp://x.example.com/a", "not a url", "javascript:alert(1)"]) {
      expect(() => loadConfig(validEnv({ RECORD_WEBHOOK_URL: bad }))).toThrow("RECORD_WEBHOOK_URL");
    }
    expect(() => loadConfig(validEnv({ AUTO_COMPLETE_ON_IDLE: "maybe" }))).toThrow("AUTO_COMPLETE_ON_IDLE");
  });
});

describe("Secret", () => {
  it("does not reveal its value when stringified, serialised or inspected", () => {
    const secret = new Secret("sk-test-value");
    const config = loadConfig(validEnv());
    const rendered = [String(secret), `${secret}`, JSON.stringify({ secret }), inspect(secret), inspect(config, { depth: 5 }), JSON.stringify(config)];
    for (const text of rendered) expect(text).not.toContain("sk-test-value");
    for (const value of Object.values(FAKE)) {
      expect(JSON.stringify(config)).not.toContain(value);
      expect(inspect(config, { depth: 5 })).not.toContain(value);
    }
    expect(JSON.stringify({ secret })).toBe('{"secret":"[Redacted]"}');
    expect(secret.reveal()).toBe("sk-test-value");
  });

  it("P5: the call's routes, voice and limits, with defaults (D06, D05, architecture §8)", () => {
    const config = loadConfig(validEnv());
    expect(config.llmRoutes).toEqual(["groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b", "gemini:gemini-flash-lite-latest"]);
    expect(config).toMatchObject({ ttsVoice: "aura-2-thalia-en", maxConcurrentCalls: 1, maxCallSeconds: 600, dailyLlmRequestBudget: 800, dailyAudioMinutesBudget: 120 });
    const custom = loadConfig(validEnv({ LLM_MODEL: "openai/gpt-oss-120b", LLM_FALLBACK_MODELS: "gemini:gemini-flash-lite-latest", TTS_VOICE: "aura-2-helena-en", MAX_CONCURRENT_CALLS: "2" }));
    expect(custom.llmRoutes).toEqual(["groq:openai/gpt-oss-120b", "gemini:gemini-flash-lite-latest"]);
    expect(custom).toMatchObject({ ttsVoice: "aura-2-helena-en", maxConcurrentCalls: 2 });
    for (const [name, value] of [["LLM_FALLBACK_MODELS", "openai:gpt-4"], ["TTS_VOICE", "thalia"], ["MAX_CONCURRENT_CALLS", "0"], ["MAX_CALL_SECONDS", "5"], ["DAILY_LLM_REQUEST_BUDGET", "0"], ["DAILY_AUDIO_MINUTES_BUDGET", "many"]]) {
      expect(() => loadConfig(validEnv({ [name as string]: value }))).toThrow(name as string);
    }
  });
});
