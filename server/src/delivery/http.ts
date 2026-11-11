// One delivery attempt (P7-T03, D17): POST the record with its idempotency key and read the verdict from the status.
// The verdict is all the worker needs; the error text is short and never holds the URL, the secret or a response body
// (it is stored in the outbox row and shown in the timeline).
import type { Secret } from "../config.js";

export type DeliveryResult =
  | { kind: "delivered" }
  /** Worth trying again later: the receiver was down, slow, rate-limiting us, or failed on its side. */
  | { kind: "retry"; error: string }
  /** Retrying can't help: the receiver rejected the request itself (4xx other than 408 and 429). */
  | { kind: "dead"; error: string };

export interface DeliveryRequest {
  url: Secret;
  /** Sent as `X-Hook-Secret`: the shared secret the receiver checks (P7-T04). */
  hookSecret: Secret;
  /** `<sessionId>:<revision>` (D17): the receiver stores a key once, so a repeat has no further effect. */
  idempotencyKey: string;
  body: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export async function postRecord({ url, hookSecret, idempotencyKey, body, timeoutMs, fetchImpl = fetch }: DeliveryRequest): Promise<DeliveryResult> {
  let response: Response;
  try {
    response = await fetchImpl(url.reveal(), {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-hook-secret": hookSecret.reveal() },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect would carry the secret header to another host: treat it as a failure instead of following it.
      redirect: "manual",
    });
  } catch (err) {
    const error = err as { name?: string; cause?: { code?: string } };
    if (error.name === "TimeoutError" || error.name === "AbortError") return { kind: "retry", error: `timeout after ${timeoutMs} ms` };
    return { kind: "retry", error: `network error${error.cause?.code ? ` (${error.cause.code})` : ""}` };
  }
  await response.body?.cancel().catch(() => {});
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: "dead", error: `HTTP ${status}` };
  return { kind: "retry", error: `HTTP ${status}` };
}
