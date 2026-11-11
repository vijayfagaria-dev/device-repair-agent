// Server configuration from environment variables, validated once at boot (D02).
// Errors name the variables that are wrong but never echo a value. Secrets are wrapped in `Secret`,
// so logging or serialising the config can't leak them; callers use `.reveal()` at the point of use.
import { inspect } from "node:util";
import { z } from "zod";

export const REDACTED = "[Redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface Config {
  readonly env: NodeEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Exact browser origin of the deployed page (`https://host`), used for Origin checks and signed URLs. */
  readonly publicOrigin: string;
  readonly deepgramApiKey: Secret;
  readonly groqApiKey: Secret;
  /** Optional last-resort LLM fallback (D06). */
  readonly geminiApiKey: Secret | null;
  readonly databaseUrl: Secret;
  readonly fileUrlSecret: Secret;
  readonly hookSecret: Secret;
  /** Set only when ALLOW_TEST_API=true (D07 test-only HTTP API). */
  readonly testApiToken: Secret | null;
  readonly quotaOverrideToken: Secret | null;
  /**
   * Reverse-proxy hops in front of the server whose X-Forwarded-For entries are trusted for the client IP
   * (0 = use the socket address). Too few makes every client share the proxy's IP; too many lets clients spoof it.
   */
  readonly trustProxyHops: number;
  /** New sessions one client IP may create per hour (P1-T03; protocol.md §2). */
  readonly newSessionsPerIpPerHour: number;
  /** AUTO_COMPLETE_ON_IDLE (D16): an idle session with every required field valid but no confirmation is `completed`. */
  readonly autoCompleteOnIdle: boolean;
  /**
   * RECORD_WEBHOOK_URL (D17): where records are delivered; null means this server's own stub receiver. A secret, because
   * a request-bin style URL can itself be the credential.
   */
  readonly recordWebhookUrl: Secret | null;
  /** IDLE_TIMEOUT_SECONDS (D16, PD3): no call and no user activity for this long → the idle timer fires. */
  readonly idleTimeoutSeconds: number;
  /** SESSION_LIFETIME_SECONDS (PD3a): a session closes this long after its last activity. */
  readonly sessionLifetimeSeconds: number;
  /** UPLOAD_BUDGET_BYTES (D10): the most all stored uploads may add up to (507 beyond it). */
  readonly uploadBudgetBytes: number;
  /** FILE_URL_TTL_SECONDS (P4-T03): how long a signed file link in a record stays valid. */
  readonly fileUrlTtlSeconds: number;
  /** LLM_MODEL + LLM_FALLBACK_MODELS (D06): the call agent's routes in order, as `provider:model`. */
  readonly llmRoutes: readonly string[];
  /** TTS_VOICE (D05): the Aura-2 voice. */
  readonly ttsVoice: string;
  /** MAX_CONCURRENT_CALLS: calls one instance runs at once (free-tier limits; starts at 1). */
  readonly maxConcurrentCalls: number;
  /** MAX_CALL_SECONDS: a call ends after this long. */
  readonly maxCallSeconds: number;
  /** DAILY_LLM_REQUEST_BUDGET: LLM requests per model in a rolling 24 h before new calls are refused (Groq free: 1,000). */
  readonly dailyLlmRequestBudget: number;
  /** DAILY_AUDIO_MINUTES_BUDGET: Deepgram audio minutes in a rolling 24 h before new calls are refused. */
  readonly dailyAudioMinutesBudget: number;
}

export interface ConfigProblem {
  readonly name: string;
  readonly problem: string;
}

export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(`Invalid server configuration:\n${problems.map((p) => `  - ${p.name} ${p.problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

// What each variable must look like. Used in error messages instead of zod's text, so no input can be echoed.
const EXPECTED = {
  NODE_ENV: "one of development, test, production",
  HOST: "a host name or IP address",
  PORT: "an integer port from 0 to 65535",
  LOG_LEVEL: "one of fatal, error, warn, info, debug, trace, silent",
  PUBLIC_ORIGIN: "an origin such as https://example.com (scheme and host only, no path)",
  DEEPGRAM_API_KEY: "an API key of at least 20 characters",
  GROQ_API_KEY: "an API key of at least 20 characters",
  GEMINI_API_KEY: "an API key of at least 20 characters, or unset",
  DATABASE_URL: "a postgres:// or postgresql:// connection URL",
  FILE_URL_SECRET: "a random secret of at least 32 characters",
  HOOK_SECRET: "a random secret of at least 32 characters",
  ALLOW_TEST_API: "true or false",
  TEST_API_TOKEN: "a random token of at least 24 characters",
  QUOTA_OVERRIDE_TOKEN: "a random token of at least 24 characters, or unset",
  AUTO_COMPLETE_ON_IDLE: "true or false",
  RECORD_WEBHOOK_URL: "an http:// or https:// URL, or unset for the built-in stub receiver",
  TRUST_PROXY_HOPS: "an integer from 0 to 5",
  NEW_SESSIONS_PER_IP_PER_HOUR: "an integer from 1 to 10000",
  IDLE_TIMEOUT_SECONDS: "an integer from 60 to 86400",
  SESSION_LIFETIME_SECONDS: "an integer from 3600 to 2592000",
  UPLOAD_BUDGET_BYTES: "an integer number of bytes from 10485760 to 943718400",
  FILE_URL_TTL_SECONDS: "an integer from 300 to 31536000",
  LLM_MODEL: "a Groq model id such as openai/gpt-oss-20b",
  LLM_FALLBACK_MODELS: "a comma-separated list of groq:<model> or gemini:<model>",
  TTS_VOICE: "an Aura-2 voice id such as aura-2-thalia-en",
  MAX_CONCURRENT_CALLS: "an integer from 1 to 20",
  MAX_CALL_SECONDS: "an integer from 60 to 3600",
  DAILY_LLM_REQUEST_BUDGET: "an integer from 1 to 1000000",
  DAILY_AUDIO_MINUTES_BUDGET: "an integer from 1 to 1000000",
} as const;

type VarName = keyof typeof EXPECTED;

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const text = () => z.string().trim();
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const required = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);
// `prefault` feeds the fallback through the schema like real input (zod 4's `default` would skip parsing).
const withDefault = <T extends z.ZodType>(schema: T, fallback: string) =>
  z.preprocess(blankToUndefined, schema.prefault(fallback as never));

const isOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isPostgresUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
  } catch {
    return false;
  }
};

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
    HOST: withDefault(text().min(1), "0.0.0.0"),
    PORT: withDefault(z.coerce.number().int().min(0).max(65535), "8080"),
    LOG_LEVEL: withDefault(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), "info"),
    PUBLIC_ORIGIN: required(text().refine(isOrigin)),
    DEEPGRAM_API_KEY: required(text().min(20)),
    GROQ_API_KEY: required(text().min(20)),
    GEMINI_API_KEY: optional(text().min(20)),
    DATABASE_URL: required(text().refine(isPostgresUrl)),
    FILE_URL_SECRET: required(text().min(32)),
    HOOK_SECRET: required(text().min(32)),
    ALLOW_TEST_API: withDefault(z.stringbool(), "false"),
    TEST_API_TOKEN: optional(text().min(24)),
    QUOTA_OVERRIDE_TOKEN: optional(text().min(24)),
    // D16 (signed off): on.
    AUTO_COMPLETE_ON_IDLE: withDefault(z.stringbool(), "true"),
    RECORD_WEBHOOK_URL: optional(text().refine(isHttpUrl)),
    TRUST_PROXY_HOPS: withDefault(z.coerce.number().int().min(0).max(5), "0"),
    NEW_SESSIONS_PER_IP_PER_HOUR: withDefault(z.coerce.number().int().min(1).max(10_000), "20"),
    // PD3: 15 minutes by default, down to 60 s for demos.
    IDLE_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().min(60).max(86_400), "900"),
    // PD3a: 7 days by default; at most 30.
    SESSION_LIFETIME_SECONDS: withDefault(z.coerce.number().int().min(3_600).max(2_592_000), "604800"),
    // D10: 600 MB by default; at least one 10 MB file, at most 900 MB (Neon's free storage is 1 GB).
    UPLOAD_BUDGET_BYTES: withDefault(z.coerce.number().int().min(10_485_760).max(943_718_400), "629145600"),
    // protocol.md §8: 30 days by default.
    FILE_URL_TTL_SECONDS: withDefault(z.coerce.number().int().min(300).max(31_536_000), "2592000"),
    // D06: gpt-oss-20b on Groq, then gpt-oss-120b (its own rate bucket), then Gemini as the last resort.
    LLM_MODEL: withDefault(text().regex(/^[A-Za-z0-9._/-]{1,100}$/), "openai/gpt-oss-20b"),
    LLM_FALLBACK_MODELS: withDefault(
      text().regex(/^((groq|gemini):[A-Za-z0-9._/-]{1,100})(,(groq|gemini):[A-Za-z0-9._/-]{1,100})*$|^$/),
      "groq:openai/gpt-oss-120b,gemini:gemini-flash-lite-latest",
    ),
    TTS_VOICE: withDefault(text().regex(/^aura-2-[a-z]+-[a-z]{2}$/), "aura-2-thalia-en"),
    // architecture §8: the concurrent-call cap starts at 1 (Groq free: 8,000 tokens/minute per model).
    MAX_CONCURRENT_CALLS: withDefault(z.coerce.number().int().min(1).max(20), "1"),
    MAX_CALL_SECONDS: withDefault(z.coerce.number().int().min(60).max(3_600), "600"),
    // Groq's free tier measured 1,000 requests/day per model (P0-T03): 800 leaves 20% headroom.
    DAILY_LLM_REQUEST_BUDGET: withDefault(z.coerce.number().int().min(1).max(1_000_000), "800"),
    // About 24 calls of the 5-minute length a claim takes; raise it with the Deepgram credit balance in view.
    DAILY_AUDIO_MINUTES_BUDGET: withDefault(z.coerce.number().int().min(1).max(1_000_000), "120"),
  })
  .superRefine((env, ctx) => {
    if (env.ALLOW_TEST_API && !env.TEST_API_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["TEST_API_TOKEN"], message: "is missing (required when ALLOW_TEST_API=true)" });
    }
    if (env.NODE_ENV === "production" && !env.PUBLIC_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_ORIGIN"], message: "is invalid (must use https in production)" });
    }
  });

function describe(issue: z.core.$ZodIssue, env: Record<string, string | undefined>): ConfigProblem {
  const name = String(issue.path[0] ?? "configuration");
  // Custom issues carry messages written above, which never include values.
  if (issue.code === "custom") return { name, problem: issue.message };
  if (blankToUndefined(env[name]) === undefined) return { name, problem: "is missing" };
  const expected = EXPECTED[name as VarName] ?? "a valid value";
  return { name, problem: `is invalid (expected ${expected})` };
}

/** Validates `env` and returns a frozen config, or throws `ConfigError` listing every bad variable by name. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // One line per variable, first problem wins.
    const byName = new Map<string, ConfigProblem>();
    for (const issue of parsed.error.issues) {
      const problem = describe(issue, env);
      if (!byName.has(problem.name)) byName.set(problem.name, problem);
    }
    throw new ConfigError([...byName.values()]);
  }
  const v = parsed.data;
  const secret = (value: string | undefined) => (value === undefined ? null : new Secret(value));
  return Object.freeze({
    env: v.NODE_ENV,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    publicOrigin: v.PUBLIC_ORIGIN,
    deepgramApiKey: new Secret(v.DEEPGRAM_API_KEY),
    groqApiKey: new Secret(v.GROQ_API_KEY),
    geminiApiKey: secret(v.GEMINI_API_KEY),
    databaseUrl: new Secret(v.DATABASE_URL),
    fileUrlSecret: new Secret(v.FILE_URL_SECRET),
    hookSecret: new Secret(v.HOOK_SECRET),
    testApiToken: v.ALLOW_TEST_API ? secret(v.TEST_API_TOKEN) : null,
    quotaOverrideToken: secret(v.QUOTA_OVERRIDE_TOKEN),
    autoCompleteOnIdle: v.AUTO_COMPLETE_ON_IDLE,
    recordWebhookUrl: secret(v.RECORD_WEBHOOK_URL),
    trustProxyHops: v.TRUST_PROXY_HOPS,
    newSessionsPerIpPerHour: v.NEW_SESSIONS_PER_IP_PER_HOUR,
    idleTimeoutSeconds: v.IDLE_TIMEOUT_SECONDS,
    sessionLifetimeSeconds: v.SESSION_LIFETIME_SECONDS,
    uploadBudgetBytes: v.UPLOAD_BUDGET_BYTES,
    fileUrlTtlSeconds: v.FILE_URL_TTL_SECONDS,
    llmRoutes: [`groq:${v.LLM_MODEL}`, ...v.LLM_FALLBACK_MODELS.split(",").filter(Boolean)],
    ttsVoice: v.TTS_VOICE,
    maxConcurrentCalls: v.MAX_CONCURRENT_CALLS,
    maxCallSeconds: v.MAX_CALL_SECONDS,
    dailyLlmRequestBudget: v.DAILY_LLM_REQUEST_BUDGET,
    dailyAudioMinutesBudget: v.DAILY_AUDIO_MINUTES_BUDGET,
  });
}
