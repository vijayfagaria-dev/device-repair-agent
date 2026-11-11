// web/src/config.ts reads the page URL once at import, so each case stubs `location`/`history` and re-imports it.
import { parseSessionId } from "@device-repair/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

function openPage(url: string): ReturnType<typeof vi.fn> {
  const page = new URL(url);
  const replaceState = vi.fn();
  vi.stubGlobal("location", { protocol: page.protocol, origin: page.origin, pathname: page.pathname, search: page.search, hash: page.hash });
  vi.stubGlobal("history", { replaceState });
  return replaceState;
}

async function loadConfig(serverUrl = "") {
  vi.stubEnv("VITE_SERVER_URL", serverUrl);
  vi.resetModules();
  return import("../src/config");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("server address", () => {
  it("defaults to the page's own origin over https (same origin, D07)", async () => {
    openPage("https://repair.example.com/?sessionId=0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b");
    const config = await loadConfig();
    expect(config.server).toEqual({ http: "https://repair.example.com", ws: "wss://repair.example.com" });
    expect(config.backend).toEqual(config.server);
    expect(config.setupProblem).toBeNull();
    expect(config.serverLabel).toBe("server https://repair.example.com");
  });

  it("defaults to the page's origin over plain http, keeping the port", async () => {
    openPage("http://localhost:8080/");
    const config = await loadConfig();
    expect(config.server).toEqual({ http: "http://localhost:8080", ws: "ws://localhost:8080" });
  });

  it("lets VITE_SERVER_URL override the page origin (vite dev on another port)", async () => {
    openPage("http://localhost:5173/");
    const config = await loadConfig("http://localhost:8080");
    expect(config.server).toEqual({ http: "http://localhost:8080", ws: "ws://localhost:8080" });
  });

  it("treats a blank VITE_SERVER_URL as unset", async () => {
    openPage("https://repair.example.com/");
    const config = await loadConfig("   ");
    expect(config.server?.http).toBe("https://repair.example.com");
  });

  it("reports an unparseable VITE_SERVER_URL instead of silently using the page origin", async () => {
    openPage("https://repair.example.com/");
    const config = await loadConfig("http://");
    expect(config.server).toBeNull();
    expect(config.setupProblem).toContain('Could not parse VITE_SERVER_URL "http://"');
  });

  it("has no backend on a page that isn't served over http(s)", async () => {
    openPage("file:///Users/me/dist/index.html");
    const config = await loadConfig();
    expect(config.server).toBeNull();
    expect(config.setupProblem).toMatch(/^No backend/);
  });

  it("demo mode never uses a backend", async () => {
    openPage("https://repair.example.com/?demo=1");
    const config = await loadConfig();
    expect(config.demo).toBe(true);
    expect(config.backend).toBeNull();
    expect(config.setupProblem).toBeNull();
    expect(config.serverLabel).toBe("demo mode (no server)");
  });
});

describe("session id", () => {
  it("creates a UUIDv4 when the URL has none and writes it into the URL", async () => {
    const replaceState = openPage("https://repair.example.com/#top");
    const config = await loadConfig();
    expect(parseSessionId(config.sessionId)).toBe(config.sessionId);
    expect(replaceState).toHaveBeenCalledWith(null, "", `/?sessionId=${config.sessionId}#top`);
  });

  it("keeps an existing id as given; the server decides whether it is valid", async () => {
    for (const id of ["0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b", "abc"]) {
      const replaceState = openPage(`https://repair.example.com/?sessionId=${id}`);
      const config = await loadConfig();
      expect(config.sessionId).toBe(id);
      expect(replaceState).not.toHaveBeenCalled();
    }
  });
});
