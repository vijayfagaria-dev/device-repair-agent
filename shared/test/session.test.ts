// Session id rules and close codes (protocol.md §2, §6).
import { describe, expect, it } from "vitest";
import { CloseCode, CloseReason, parseSessionId, SESSION_ID_PATTERN } from "../protocol/index.js";

describe("parseSessionId", () => {
  it("accepts UUIDv4 in either case and returns it lowercase", () => {
    const id = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b";
    expect(parseSessionId(id)).toBe(id);
    expect(parseSessionId(id.toUpperCase())).toBe(id);
  });

  it("rejects everything that is not a UUIDv4", () => {
    const rejected: unknown[] = [
      "abc",
      "",
      undefined,
      null,
      42,
      ["0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b"],
      "0b6f4c1e-3d2a-1e8b-9a71-5c2d8e9f1a3b", // version 1
      "0b6f4c1e-3d2a-4e8b-7a71-5c2d8e9f1a3b", // wrong variant
      "0b6f4c1e3d2a4e8b9a715c2d8e9f1a3b", // no hyphens
      " 0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b", // padding
      "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b\n",
      "{0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b}",
      "lzx8k2m-4f9q2c1d", // the starter's old Date.now() fallback shape
      "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3g",
    ];
    for (const value of rejected) expect(parseSessionId(value), String(value)).toBeNull();
  });

  it("matches the pattern published in protocol.md §2", () => {
    expect(SESSION_ID_PATTERN.source).toBe("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    expect(SESSION_ID_PATTERN.flags).toBe("i");
  });
});

describe("close codes", () => {
  it("keeps the codes and reasons documented in protocol.md §6", () => {
    expect({ ...CloseCode }).toMatchObject({
      NORMAL: 1000,
      MESSAGE_TOO_BIG: 1009,
      SERVER_ERROR: 1011,
      SERVER_RESTARTING: 1012,
      INVALID_SESSION_ID: 4400,
      ORIGIN_NOT_ALLOWED: 4403,
      CALL_ALREADY_ACTIVE: 4409,
      SESSION_CLOSED: 4410,
      RESUME_REQUIRED: 4411,
      RATE_LIMITED: 4429,
    });
    expect(CloseReason).toEqual({
      SERVER_ERROR: "server error",
      SERVER_RESTARTING: "server restarting",
      INVALID_SESSION_ID: "invalid session id",
      ORIGIN_NOT_ALLOWED: "origin not allowed",
      NEW_SESSION_RATE_LIMITED: "rate limited",
    });
  });
});
