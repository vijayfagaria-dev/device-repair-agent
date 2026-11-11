import { randomId } from "./lib/ids";

export interface Server {
  http: string;
  ws: string;
}

const DEFAULT_DEMO_PACE = 1.5;

function parseServer(raw: string): Server | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const hostPath = url.host + url.pathname.replace(/\/+$/, "");
    return { http: `${secure ? "https" : "http"}://${hostPath}`, ws: `${secure ? "wss" : "ws"}://${hostPath}` };
  } catch {
    return null;
  }
}

function readSessionId(params: URLSearchParams): string {
  const existing = params.get("sessionId");
  if (existing) return existing;
  const created = randomId();
  params.set("sessionId", created);
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  return created;
}

function describeServer(): string {
  if (demo) return "demo mode (no server)";
  return server ? `server ${server.http}` : "no server";
}

function describeSetupProblem(): string | null {
  if (demo || server) return null;
  return configuredServer
    ? `Could not parse VITE_SERVER_URL "${configuredServer}". Use e.g. http://localhost:8080`
    : "No backend: open this page from the server over http or https, or set VITE_SERVER_URL in .env.local (see .env.example), or open ?demo=1 to see the intended flow.";
}

const params = new URLSearchParams(location.search);
const pace = Number(params.get("pace"));
// The server serves this page, so by default the backend is the page's own origin (D07: same origin, no CORS).
// VITE_SERVER_URL overrides it, e.g. for `npm run dev` against a server on another port.
const configuredServer = import.meta.env.VITE_SERVER_URL?.trim() ?? "";
const pageOrigin = location.protocol === "http:" || location.protocol === "https:" ? location.origin : "";
const rawServer = configuredServer || pageOrigin;

export const sessionId = readSessionId(params);
export const demo = params.get("demo") === "1";
export const demoPace = pace > 0 ? pace : DEFAULT_DEMO_PACE;
export const server = parseServer(rawServer);
export const backend = demo ? null : server;
export const serverLabel = describeServer();
export const setupProblem = describeSetupProblem();
