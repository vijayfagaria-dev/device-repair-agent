// The spec side of the E2E backend's control API (support/backend-process.mjs).
const control = (path: string) => `${process.env.E2E_CONTROL}${path}`;
const post = async (path: string, body: unknown = {}) => {
  const response = await fetch(control(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<unknown>;
};
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(control(path));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

export const baseUrl = (): string => process.env.E2E_URL as string;
/** Fresh fakes: call at the start of every test. */
export const fresh = () => post("/fresh");
export interface LlmScript {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
}
export const script = (...scripts: LlmScript[]) => post("/llm", { scripts });
export const interim = (text: string) => post("/stt/interim", { text });
export const say = (text: string) => post("/stt/say", { text });
export interface Stats {
  sttStreams: number;
  sttBytes: number;
  ttsStreams: number;
  llmQueued: number;
  llmRequests: number;
}
export const stats = () => get<Stats>("/stats");
export const fireTimer = (sessionId: string, kind: string) => post("/timer", { sessionId, kind });
export interface StoredRecord {
  revision: number;
  outcome: string;
  payload: Record<string, unknown>;
}
export const records = (sessionId: string) => get<StoredRecord[]>(`/records?sessionId=${sessionId}`);
export const session = (sessionId: string) => get<{ status: string; outcome: string | null; activeCallId: string | null }>(`/session?sessionId=${sessionId}`);
