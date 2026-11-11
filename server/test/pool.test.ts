import { describe, expect, it } from "vitest";
import { connectionSettings, isTransientDbError } from "../src/db/pool.js";

describe("connectionSettings", () => {
  it("verifies TLS for remote hosts and strips sslmode from the string", () => {
    const s = connectionSettings("postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
    expect(s.ssl).toEqual({ rejectUnauthorized: true });
    expect(s.connectionString).not.toContain("sslmode");
    expect(s.connectionString).toContain("channel_binding=require");
  });

  it("verifies TLS for a remote host even without sslmode", () => {
    expect(connectionSettings("postgresql://u:p@db.example.com/app").ssl).toEqual({ rejectUnauthorized: true });
  });

  it("uses plain TCP for local hosts without sslmode, and whenever sslmode=disable", () => {
    expect(connectionSettings("postgresql://postgres@127.0.0.1:5432/postgres").ssl).toBe(false);
    expect(connectionSettings("postgresql://postgres@localhost/postgres").ssl).toBe(false);
    expect(connectionSettings("postgresql://u@db.example.com/app?sslmode=disable").ssl).toBe(false);
    expect(connectionSettings("postgresql://postgres@localhost/postgres?sslmode=require").ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe("isTransientDbError", () => {
  const withCode = (code: string, message = "x") => Object.assign(new Error(message), { code });

  it("retries connection-level failures", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "08006", "08001", "57P01", "57P03"]) {
      expect(isTransientDbError(withCode(code)), code).toBe(true);
    }
    expect(isTransientDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("never retries SQL errors or protocol violations", () => {
    for (const code of ["42P01", "23505", "42601", "28P01", "08P01", "P0001"]) {
      expect(isTransientDbError(withCode(code)), code).toBe(false);
    }
    expect(isTransientDbError("not an error")).toBe(false);
  });
});
