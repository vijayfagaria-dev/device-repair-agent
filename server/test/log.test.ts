import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { FAKE, validEnv } from "./fixtures.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger("info", stream);
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("createLogger", () => {
  it('redacts {apiKey:"sk-test"} to [Redacted]', () => {
    const { logger, lines, parsed } = capture();
    logger.info({ apiKey: "sk-test" }, "provider call");
    expect(lines.join("")).not.toContain("sk-test");
    expect(parsed()[0]).toMatchObject({ apiKey: "[Redacted]", msg: "provider call", level: "info" });
  });

  it("redacts the plan's paths: *.apiKey, headers.authorization, *.token, *.secret", () => {
    const { logger, lines, parsed } = capture();
    logger.info({
      provider: { apiKey: "sk-nested" },
      headers: { authorization: "Bearer sk-header", cookie: "sid=sk-cookie" },
      req: { headers: { authorization: "Bearer sk-req" } },
      upload: { token: "sk-token" },
      hook: { secret: "sk-secret" },
      token: "sk-top-token",
    });
    const output = lines.join("");
    for (const value of ["sk-nested", "sk-header", "sk-cookie", "sk-req", "sk-token", "sk-secret", "sk-top-token"]) {
      expect(output).not.toContain(value);
    }
    expect(parsed()[0]).toMatchObject({
      provider: { apiKey: "[Redacted]" },
      headers: { authorization: "[Redacted]" },
      upload: { token: "[Redacted]" },
      hook: { secret: "[Redacted]" },
    });
  });

  it("never prints config secrets, even when the whole config is logged", () => {
    const { logger, lines } = capture();
    logger.info({ config: loadConfig(validEnv()) }, "config");
    const output = lines.join("");
    for (const value of Object.values(FAKE)) expect(output).not.toContain(value);
    expect(output).toContain("[Redacted]");
  });

  it("writes one JSON object per line with an ISO timestamp", () => {
    const { logger, parsed } = capture();
    logger.warn("hello");
    const [line] = parsed();
    expect(line).toMatchObject({ level: "warn", msg: "hello", service: "device-repair-agent" });
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
