import { sessionId, type Server } from "../config";
import { errorMessage } from "../lib/errors";
import type { InputValue, UploadResponse } from "@voice-chat-agent/shared/protocol";

export async function uploadFiles(server: Server, files: File[], multiple: boolean): Promise<InputValue> {
  const urls: string[] = [];
  for (const file of files) urls.push(await upload(server, file));
  return multiple ? urls : (urls[0] ?? null);
}

async function upload(server: Server, file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const url = `${server.http}/sessions/${encodeURIComponent(sessionId)}/files`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body });
  } catch (err) {
    throw new Error(`Upload of ${file.name} failed: ${errorMessage(err, "network error")}.`);
  }
  if (!response.ok) {
    // protocol.md §8: { error: { code, message } }; the message is written for the user ("That file is larger than 10 MB.").
    const body: { error?: { message?: unknown } } | null = await response.json().catch(() => null);
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    throw new Error(message ? `Upload of ${file.name} failed: ${message}` : `Upload of ${file.name} failed (${response.status}).`);
  }
  const result: Partial<UploadResponse> | null = await response.json().catch(() => null);
  if (!result?.url) throw new Error(`Upload of ${file.name} returned no url.`);
  return result.url;
}
