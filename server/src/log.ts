// Structured JSON logs (pino) with secret redaction from day one (D02, D19).
// Redaction is by key name; config secrets are also `Secret` objects that serialise as "[Redacted]" at any depth.
import { pino, stdTimeFunctions, type DestinationStream, type Logger } from "pino";
import { REDACTED, type LogLevel } from "./config.js";

const SENSITIVE_KEYS = ["apiKey", "token", "secret", "password", "authorization", "cookie"];

export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "*.headers.authorization",
  "*.headers.cookie",
  '*.headers["set-cookie"]',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: "device-repair-agent" },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
  };
  return destination ? pino(options, destination) : pino(options);
}
