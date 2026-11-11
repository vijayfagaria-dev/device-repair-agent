// Deployed synthetic end-to-end run and restart verification (P10-T05). Runs against a PUBLIC URL with the real
// providers (Deepgram, Groq), like a reviewer would use the system: both sockets, speech from a WAV streamed in real
// time, chat cards answered while the call is on, a barge-in, a hang-up, the rest of the claim in chat, the record and
// the receiver. Plain Node 22 (type stripping), no build:
//
//   node test/deployed/e2e.ts https://<app>.onrender.com                    # DATABASE_URL in the environment (see below)
//   node test/deployed/e2e.ts https://<app>.onrender.com --restart          # restart the service mid-call, then verify
//   ... --no-db                                                             # skip the database checks (reported as skipped)
//
// It uses real free-tier quota (a few minutes of Deepgram audio, about 20 Groq requests), so it is run deliberately,
// never on every push. Exit 0 only if every check passed; 1 on any failed or skipped check; 2 on bad arguments.
//
// Environment (shell only, never argv; nothing is printed):
//   DATABASE_URL            the Neon URL: read-only checks of the receiver row, the records count and the usage ledger.
//   RENDER_DEPLOY_HOOK_URL  (--restart) a Render deploy hook the script calls itself; without it, it waits for you to press
//                           Restart in the Render dashboard and then Enter. Keep it in server/.env, never commit it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { WebSocket } from "ws";

const MIC_FRAME_BYTES = 640;
const FRAME_MS = 20;
const SPEECH_WAV = readFileSync(new URL("../fixtures/audio/u1.wav", import.meta.url));
const FIRST_REQUEST_TIMEOUT_MS = 120_000; // a sleeping free instance takes about a minute to wake

/** What the acceptance criteria require, in milliseconds. */
export interface Limits {
  agentAudioAfterConnectMs: number;
  stopPlaybackAfterSpeechMs: number;
  handoffAfterHangupMs: number;
  acknowledgementMs: number;
}
export const DEFAULT_LIMITS: Limits = { agentAudioAfterConnectMs: 3_000, stopPlaybackAfterSpeechMs: 1_000, handoffAfterHangupMs: 1_000, acknowledgementMs: 20_000 };

export interface Options {
  base: URL;
  restart: boolean;
  /** Null: the database checks are skipped (and reported as such, which fails the run). */
  databaseUrl: string | null;
  noDb: boolean;
  /** `--restart`: restarts the service. Resolves when the operator (or the deploy hook) has done it. */
  restartService: () => Promise<void>;
  limits: Limits;
  log: (line: string) => void;
}

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => T | undefined | null | false, everyMs = 25): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs)} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

type Json = Record<string, unknown>;

/** A WebSocket that keeps every message with the time it arrived. */
class Wire {
  readonly messages: { at: number; msg: Json; binary: boolean }[] = [];
  closed: { at: number; code: number; reason: string } | null = null;
  /** Cards this run has sent an answer to (the server's answer bubble follows a moment later). */
  readonly submitted = new Set<string>();
  openedAt = 0;
  readonly createdAt = now();
  readonly ws: WebSocket;

  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { headers: { origin } });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        this.messages.push({ at: now(), msg: JSON.parse(String(data)) as Json, binary: false });
      } catch {
        // not a message we understand: ignored, like the page does
      }
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { at: now(), code, reason: String(reason) };
    });
    this.ws.on("error", () => {});
  }

  async opened(timeoutMs = 20_000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not open")), timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        this.openedAt = now();
        resolve();
      });
      this.ws.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`socket closed during the handshake (code ${code})`));
      });
      this.ws.once("error", () => {});
    });
  }

  of(type: string): { at: number; msg: Json }[] {
    return this.messages.filter((m) => m.msg.type === type);
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(code = 1000): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Audio: 20 ms frames of the speech fixture, sent in real time

function wavPcm(wav: Buffer): Buffer {
  const at = wav.indexOf("data");
  if (at < 0) throw new Error("not a WAV file");
  return wav.subarray(at + 8);
}
const SPEECH = wavPcm(SPEECH_WAV);

/** The offset (ms) of the first frame that is clearly speech: where the user's speech "starts" for latency purposes. */
export function speechOnsetMs(pcm: Buffer): number {
  for (let i = 0; i + MIC_FRAME_BYTES <= pcm.length; i += MIC_FRAME_BYTES) {
    let sum = 0;
    for (let j = i; j < i + MIC_FRAME_BYTES; j += 2) sum += pcm.readInt16LE(j) ** 2;
    if (Math.sqrt(sum / (MIC_FRAME_BYTES / 2)) > 1_500) return (i / MIC_FRAME_BYTES) * FRAME_MS;
  }
  return 0;
}

class Mic {
  #running = false;
  #queue: Buffer[] = [];
  #timer: NodeJS.Timeout | null = null;
  #wire: Wire;
  framesSent = 0;
  constructor(wire: Wire) {
    this.#wire = wire;
  }

  /** Streams silence, and any queued speech, one frame every 20 ms until stopped. A mic never goes quiet. */
  start(): void {
    this.#running = true;
    const silence = Buffer.alloc(MIC_FRAME_BYTES);
    let next = now();
    const tick = () => {
      if (!this.#running) return;
      const frame = this.#queue.shift() ?? silence;
      if (this.#wire.ws.readyState === WebSocket.OPEN) {
        this.#wire.ws.send(frame);
        this.framesSent += 1;
      }
      next += FRAME_MS;
      this.#timer = setTimeout(tick, Math.max(0, next - now()));
    };
    tick();
  }

  /**
   * Queues `pcm` and trailing silence. `onsetAt` is the clock time the first loud frame leaves; `done` resolves once
   * every queued frame has been sent.
   */
  speak(pcm: Buffer = SPEECH, trailingSilenceMs = 1_500): { onsetAt: number; done: Promise<void> } {
    const frames: Buffer[] = [];
    for (let i = 0; i + MIC_FRAME_BYTES <= pcm.length; i += MIC_FRAME_BYTES) frames.push(pcm.subarray(i, i + MIC_FRAME_BYTES));
    for (let i = 0; i < trailingSilenceMs / FRAME_MS; i++) frames.push(Buffer.alloc(MIC_FRAME_BYTES));
    const onsetAt = now() + (this.#queue.length + speechOnsetMs(pcm) / FRAME_MS) * FRAME_MS;
    this.#queue.push(...frames);
    const done = (async () => {
      while (this.#queue.length > 0 && this.#running) await sleep(FRAME_MS);
    })();
    return { onsetAt, done };
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
  }
}

/** Seconds of audio in the `audio` messages received so far (each is PCM16 mono at its own sample rate). */
function audioSeconds(wire: Wire): number {
  return wire.of("audio").reduce((sum, { msg }) => sum + Buffer.from(String(msg.data), "base64").length / 2 / Number(msg.sampleRate ?? 24_000), 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// The chat side: answering whichever card is open the way a user would

interface Card {
  id: string;
  field: string;
  kind: string;
  label: string;
  options?: { value: string }[];
  multiple?: boolean;
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const fiveDaysAgo = () => new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TEXT_ANSWERS: Record<string, string> = {
  deviceModel: "Samsung Galaxy S23",
  problemDescription: "The screen flickers and then goes black after a minute",
  serialNumber: "352099001761481",
  email: "asha.rao@example.com",
  additionalNotes: "",
};

/** Every card the server has sent that hasn't been answered or cancelled yet. */
function openCards(chat: Wire): Card[] {
  const answered = new Set(chat.of("message").map((m) => String(m.msg.requestId ?? "")));
  const cancelled = new Set(chat.of("inputCancel").map((m) => String(m.msg.requestId)));
  // A card paused by Stop and resumed reuses its id: a later inputRequest with the same id is the same card.
  const cards = new Map<string, Card>();
  for (const { msg } of chat.of("inputRequest")) cards.set(String(msg.id), msg as unknown as Card);
  return [...cards.values()].filter((c) => !answered.has(c.id) && !cancelled.has(c.id) && !chat.submitted.has(c.id));
}

async function upload(base: URL, sessionId: string, name: string, bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  const response = await fetch(new URL(`/sessions/${sessionId}/files`, base), { method: "POST", body: form, headers: { origin: base.origin } });
  if (!response.ok) throw new Error(`upload refused: HTTP ${response.status}`);
  const body = (await response.json()) as { url?: string };
  if (typeof body.url !== "string") throw new Error("upload gave no url");
  return body.url;
}

/** The answer a user would give this card, or throws if the card is one the script doesn't know. */
async function answerFor(card: Card, base: URL, sessionId: string): Promise<string | number | boolean | string[] | null> {
  switch (card.kind) {
    case "select":
      return card.options?.[0]?.value ?? null;
    case "confirm":
      return true;
    case "date":
      return fiveDaysAgo();
    case "file": {
      if (card.field === "additionalPhotos") return null; // optional: skip
      const url = await upload(base, sessionId, "invoice.pdf", PDF);
      return card.multiple ? [url] : url;
    }
    default: {
      const text = TEXT_ANSWERS[card.field];
      if (text === undefined) throw new Error(`no scripted answer for the card "${card.label}" (${card.field})`);
      return text === "" ? null : text;
    }
  }
}

async function answerCard(chat: Wire, card: Card, base: URL, sessionId: string): Promise<number> {
  const value = await answerFor(card, base, sessionId);
  chat.submitted.add(card.id);
  const at = now();
  chat.send({ type: "inputResponse", requestId: card.id, field: card.field, value });
  return at;
}

/** Cards that name the field the agent can acknowledge by words. */
const ACKNOWLEDGES: Record<string, RegExp> = {
  serialNumber: /serial|imei/i,
  email: /e-?mail/i,
  purchaseInvoice: /invoice|receipt|purchase|upload/i,
  deviceModel: /model|galaxy|samsung|brand/i,
  problemStartedAt: /when|start|began|days?/i,
  deviceType: /phone|device|laptop|tablet|watch/i,
  urgency: /urgen|soon|quick/i,
  serviceCentre: /service|cent(er|re)/i,
};

// ---------------------------------------------------------------------------------------------------------------------
// The run

export async function runE2E(options: Options): Promise<{ results: CheckResult[]; summary: Json; sessionId: string }> {
  const { base, limits, log } = options;
  const origin = base.origin;
  const wsBase = new URL(base);
  wsBase.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const results: CheckResult[] = [];
  const summary: Json = {};
  const sessionId = randomUUID();

  async function check(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      const returned = await fn();
      const detail = typeof returned === "string" ? returned : "";
      results.push({ name, status: "pass", detail });
      log(`PASS  ${name}${detail ? ` (${detail})` : ""}`);
      return true;
    } catch (err) {
      const detail = (err as Error).message;
      results.push({ name, status: "fail", detail });
      log(`FAIL  ${name}: ${detail}`);
      return false;
    }
  }
  const skip = (name: string, why: string) => {
    results.push({ name, status: "skip", detail: why });
    log(`SKIP  ${name}: ${why}`);
  };
  const fetchText = async (path: string, timeoutMs = 20_000) => {
    const response = await fetch(new URL(path, base), { headers: { origin }, signal: AbortSignal.timeout(timeoutMs) });
    return { response, text: await response.text() };
  };

  // 1. The service is up, and what the browser downloads is clean. -----------------------------------------------------
  await check("service is up (/healthz, waiting for a sleeping instance to wake)", async () => {
    const started = now();
    for (;;) {
      try {
        const { response } = await fetchText("/healthz", 15_000);
        if (response.status === 200) return `${Math.round(now() - started)} ms`;
      } catch {
        // still waking
      }
      if (now() - started > FIRST_REQUEST_TIMEOUT_MS) throw new Error("no 200 from /healthz within 120 s");
      await sleep(2_000);
    }
  });
  await check("security headers on the page", async () => {
    const { response } = await fetchText("/");
    const need = ["content-security-policy", "referrer-policy", "permissions-policy", "x-content-type-options"];
    // HSTS is only sent (and only means something) over https; a local http run has none.
    if (base.protocol === "https:") need.push("strict-transport-security");
    const missing = need.filter((h) => !response.headers.get(h));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    if (!response.headers.get("permissions-policy")?.includes("microphone=(self)")) throw new Error("permissions-policy lacks microphone=(self)");
    if (/unsafe-/.test(response.headers.get("content-security-policy") ?? "")) throw new Error("CSP allows unsafe-*");
  });
  await check("the deployed web bundle contains no secret", async () => {
    const { text: html } = await fetchText("/");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
    if (assets.length === 0) throw new Error("the page references no assets");
    const rules: [string, RegExp][] = [
      ["groq key", /gsk_[A-Za-z0-9]{20,}/],
      ["google api key", /AIza[0-9A-Za-z_-]{30,}/],
      ["openai-style key", /sk-[A-Za-z0-9_-]{20,}/],
      ["bearer token", /[Bb]earer [A-Za-z0-9._~+/=-]{20,}/],
      ["database url", /postgres(ql)?:\/\/[^"' ]+@/],
      ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ["server secret name", /(DEEPGRAM_API_KEY|GROQ_API_KEY|GEMINI_API_KEY|DATABASE_URL|FILE_URL_SECRET|HOOK_SECRET|TEST_API_TOKEN|QUOTA_OVERRIDE_TOKEN)/],
      ["hook secret header", /[Xx]-[Hh]ook-[Ss]ecret/],
    ];
    const leaks: string[] = [];
    for (const asset of [...assets, "/"]) {
      const { text } = await fetchText(asset);
      for (const [name, pattern] of rules) if (pattern.test(text)) leaks.push(`${name} in ${asset}`); // never the match
    }
    if (leaks.length) throw new Error(leaks.join("; "));
    return `${assets.length} assets scanned`;
  });

  // 2. The call. -----------------------------------------------------------------------------------------------------
  const chat = new Wire(`${wsBase.origin}/chat?sessionId=${sessionId}`, origin);
  await chat.opened();
  await waitUntil("the chat replay (syncDone)", 20_000, () => chat.of("syncDone").length > 0);
  const call = new Wire(`${wsBase.origin}/call?sessionId=${sessionId}`, origin);
  const mic = new Mic(call);
  let callOk = false;
  await check(`agent audio arrives within ${limits.agentAudioAfterConnectMs} ms of connecting the call`, async () => {
    await call.opened();
    mic.start();
    const first = await waitUntil("the greeting's first audio", 15_000, () => call.of("audio")[0]);
    const ms = Math.round(first.at - call.openedAt);
    summary.firstAudioAfterConnectMs = ms;
    if (ms > limits.agentAudioAfterConnectMs) throw new Error(`${ms} ms`);
    callOk = true;
    return `${ms} ms`;
  });
  if (!callOk) {
    mic.stop();
    call.close();
    chat.close();
    return { results, summary, sessionId };
  }
  await check("the greeting is a transcript line from the agent", async () => {
    const line = await waitUntil("the greeting transcript", 15_000, () => call.of("transcript").find((m) => m.msg.role === "agent" && m.msg.final === true));
    return `"${String(line.msg.text).slice(0, 60)}"`;
  });
  // The greeting plays in real time: speak after it has finished, as a person would.
  const greetingEnd = (call.of("audio")[0]?.at ?? now()) + audioSeconds(call) * 1000;
  await sleep(Math.max(0, greetingEnd - now()) + 400);

  const agentLines = () => call.of("transcript").filter((m) => m.msg.role === "agent" && m.msg.final === true);
  const userLines = () => call.of("transcript").filter((m) => m.msg.role === "user" && m.msg.final === true);

  await check("the user's speech is transcribed and the agent answers in speech", async () => {
    const before = agentLines().length;
    const audioBefore = call.of("audio").length;
    const spoke = mic.speak();
    const speechEnd = spoke.onsetAt + ((SPEECH.length / MIC_FRAME_BYTES) * FRAME_MS - speechOnsetMs(SPEECH));
    await waitUntil("the user's final transcript", 20_000, () => userLines()[0]);
    await spoke.done;
    await waitUntil("the agent's answer", 30_000, () => agentLines().length > before && call.of("audio").length > audioBefore);
    const answerAudio = call.of("audio").find((m, i) => i >= audioBefore && m.at > speechEnd - 500);
    if (answerAudio) summary.speechEndToFirstAnswerAudioMs = Math.round(answerAudio.at - speechEnd);
    return `heard "${String(userLines()[0]?.msg.text).slice(0, 50)}"`;
  });

  // 3. A card answered in chat while the call is on, acknowledged by the agent. ---------------------------------------
  let acknowledgedField: string | null = null;
  await check(`a chat submission during the call is acknowledged by the agent within ${limits.acknowledgementMs} ms`, async () => {
    // The agent asks for typed values with request_chat_input; give it two turns to do so.
    let card = openCards(chat)[0];
    for (let turn = 0; !card && turn < 2; turn++) {
      const spoke = mic.speak();
      card = await waitUntil("a card to open in chat during the call", 30_000, () => openCards(chat)[0]).catch(() => undefined);
      await spoke.done;
    }
    if (!card) throw new Error("no card opened in chat while the call was on");
    // Never while the user is speaking: the mic is quiet now; wait for the agent to finish its own line.
    await sleep(500);
    const agentBefore = agentLines().length;
    const submittedAt = await answerCard(chat, card, base, sessionId);
    acknowledgedField = card.field;
    const pattern = ACKNOWLEDGES[card.field] ?? /thanks|thank you|got it|received/i;
    const line = await waitUntil(
      `the agent to mention the ${card.field} you submitted`,
      limits.acknowledgementMs,
      () => agentLines().slice(agentBefore).find((m) => m.at > submittedAt && pattern.test(String(m.msg.text))),
      50,
    );
    return `${card.field} acknowledged ${Math.round(line.at - submittedAt)} ms after submitting`;
  });

  // 4. The restart variant pauses here, with the call live and a session part-way through. ---------------------------
  if (options.restart) return restartAndFinish();

  // 5. Barge-in. ---------------------------------------------------------------------------------------------------
  await check(`barge-in: stopPlayback within ${limits.stopPlaybackAfterSpeechMs} ms of the injected speech and the agent line is truncated`, async () => {
    // Make the agent talk (it answers whatever we say), then talk over it.
    const audioBefore = call.of("audio").length;
    await mic.speak(SPEECH, 300).done;
    await waitUntil("the agent to start speaking", 30_000, () => call.of("audio").length > audioBefore);
    await sleep(500); // past the barge-in confirmation window, mid-sentence
    const stopsBefore = call.of("stopPlayback").length;
    const interruption = mic.speak(SPEECH, 1_500);
    const onset = interruption.onsetAt;
    const stop = await waitUntil("stopPlayback", 10_000, () => call.of("stopPlayback")[stopsBefore]);
    const ms = Math.round(stop.at - onset);
    summary.stopPlaybackAfterSpeechMs = ms;
    if (ms > limits.stopPlaybackAfterSpeechMs) throw new Error(`${ms} ms (limit ${limits.stopPlaybackAfterSpeechMs})`);
    await waitUntil("the interrupted agent line", 15_000, () => agentLines().find((m) => String(m.msg.text).endsWith("[interrupted]")));
    await interruption.done;
    return `${ms} ms`;
  });

  // 6. Hang up; the chat takes over. ------------------------------------------------------------------------------------
  await check(`after hang-up the chat continues within ${limits.handoffAfterHangupMs} ms (the next message or card)`, async () => {
    // Let the interrupting utterance finish and the agent settle.
    await sleep(2_000);
    const seen = chat.messages.length;
    const hungUpAt = now();
    mic.stop();
    call.close(1000);
    const next = await waitUntil("a chat message after the hang-up", 10_000, () => chat.messages.slice(seen).find((m) => m.msg.type === "message" || m.msg.type === "inputRequest"));
    const ms = Math.round(next.at - hungUpAt);
    summary.handoffAfterHangupMs = ms;
    await waitUntil("a card to be open", 10_000, () => openCards(chat)[0]);
    if (ms > limits.handoffAfterHangupMs) throw new Error(`${ms} ms (limit ${limits.handoffAfterHangupMs})`);
    return `${ms} ms`;
  });

  // 7. The rest of the claim in chat; the record. -----------------------------------------------------------------------
  const record = await finishInChat(chat, "complete the claim in chat and receive the record");
  await verifyRecord(record);
  await verifyDatabase(1);
  chat.close();
  call.close();
  summary.acknowledgedField = acknowledgedField;
  return { results, summary, sessionId };

  // -------------------------------------------------------------------------------------------------------------------

  async function finishInChat(wire: Wire, name: string): Promise<Json | null> {
    let record: Json | null = null;
    await check(name, async () => {
      let answered = 0;
      for (let i = 0; i < 24 && !record; i++) {
        const found = await waitUntil("a card or the record", 20_000, () => wire.of("record")[0] ?? openCards(wire)[0]);
        if ("msg" in found) {
          record = (found.msg as { record: Json }).record;
          break;
        }
        const card = found as Card;
        await answerCard(wire, card, base, sessionId);
        answered += 1;
        // Taken (an answer bubble for this card) or refused (an inputError), or the claim is already done.
        await waitUntil(
          "the server to take the answer",
          20_000,
          () => wire.of("record")[0] ?? wire.of("inputError").find((m) => m.msg.requestId === card.id) ?? wire.of("message").find((m) => m.msg.requestId === card.id),
        );
        const rejected = wire.of("inputError").find((m) => m.msg.requestId === card.id);
        if (rejected) throw new Error(`the server refused the answer to "${card.label}": ${String(rejected.msg.message)}`);
      }
      if (!record) throw new Error("the claim did not reach a record");
      return `${answered} cards answered in chat`;
    });
    return record;
  }

  async function verifyRecord(record: Json | null): Promise<void> {
    await check("the record is completed, revision 1, for this session, with every required field valid", async () => {
      if (!record) throw new Error("no record");
      if (record.sessionId !== sessionId) throw new Error("wrong sessionId");
      if (record.outcome !== "completed") throw new Error(`outcome ${String(record.outcome)} (${String(record.outcomeReason)})`);
      if (record.revision !== 1) throw new Error(`revision ${String(record.revision)}`);
      const fields = record.fields as Record<string, { status: string; source: string | null }>;
      const bad = Object.entries(fields).filter(([name, f]) => f.status !== "valid" && !["additionalPhotos", "additionalNotes"].includes(name));
      if (bad.length) throw new Error(`not valid: ${bad.map(([n, f]) => `${n}=${f.status}`).join(", ")}`);
      const engagement = record.engagement as { calls?: number } | undefined;
      if (!engagement || (engagement.calls ?? 0) < 1) throw new Error("the record shows no call");
      const sources = new Set(Object.values(fields).map((f) => f.source).filter(Boolean));
      return `sources: ${[...sources].join("+")}`;
    });
    await check("the invoice in the record downloads through its signed link", async () => {
      const invoice = (record?.fields as Record<string, { value?: { url?: string } }> | undefined)?.purchaseInvoice?.value;
      if (!invoice?.url) throw new Error("no signed URL in the record");
      const response = await fetch(invoice.url);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const forged = await fetch(`${invoice.url}x`);
      if (forged.status === 200) throw new Error("a tampered link was accepted");
    });
    await check("the session reads back as finalized and completed over HTTP", async () => {
      const { response, text } = await fetchText(`/api/sessions/${sessionId}`);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = JSON.parse(text) as { status?: string; outcome?: string };
      if (body.status !== "finalized" || body.outcome !== "completed") throw new Error(`status ${String(body.status)}, outcome ${String(body.outcome)}`);
    });
  }

  async function verifyDatabase(expectedRevisions: number): Promise<void> {
    const name = "the receiver holds exactly one row for revision 1 and the session has one record (database)";
    if (options.noDb || !options.databaseUrl) return skip(name, options.noDb ? "--no-db" : "DATABASE_URL is not set");
    const client = new pg.Client({ connectionString: options.databaseUrl, statement_timeout: 15_000 });
    await check(name, async () => {
      await client.connect();
      try {
        // The outbox delivers after the commit: give it a moment.
        const row = await waitUntilAsync(30_000, async () => (await client.query("SELECT times_received FROM received_records WHERE idempotency_key = $1", [`${sessionId}:1`])).rows[0]);
        const records = await client.query("SELECT count(*)::int AS n FROM records WHERE session_id = $1", [sessionId]);
        const received = await client.query("SELECT count(*)::int AS n FROM received_records WHERE idempotency_key LIKE $1", [`${sessionId}:%`]);
        if (records.rows[0].n !== expectedRevisions) throw new Error(`${records.rows[0].n} records for the session`);
        if (received.rows[0].n !== expectedRevisions) throw new Error(`${received.rows[0].n} receiver rows for the session`);
        const usage = await client.query("SELECT provider, kind, sum(units)::float AS units, sum(cost_usd)::float AS cost FROM usage WHERE session_id = $1 GROUP BY provider, kind ORDER BY provider, kind", [sessionId]);
        summary.timesReceived = row.times_received;
        summary.usage = usage.rows.map((r) => `${r.provider}:${r.kind}=${Number(r.units).toFixed(1)}`);
        summary.listPriceCostUsd = Number(usage.rows.reduce((s, r) => s + r.cost, 0).toFixed(6));
        return `delivered ${row.times_received}×, stored once`;
      } finally {
        await client.end().catch(() => {});
      }
    });
  }

  async function restartAndFinish(): Promise<{ results: CheckResult[]; summary: Json; sessionId: string }> {
    const before = { messages: chat.messages.filter((m) => m.msg.type === "message" || m.msg.type === "transcript").length };
    await check("restart: the service restarts while the call is live", async () => {
      log("restarting the service now (call live, one card answered)…");
      await options.restartService();
      // The sockets drop (1012 on a graceful shutdown, 1006 if it was cut), and the service comes back healthy.
      await waitUntil("the call socket to close", 60_000, () => call.closed, 100);
      mic.stop();
      await waitUntil("the chat socket to close", 30_000, () => chat.closed, 100);
      const closedAt = now();
      for (;;) {
        try {
          const { response } = await fetchText("/readyz", 10_000);
          if (response.status === 200) break;
        } catch {
          // not back yet
        }
        if (now() - closedAt > 240_000) throw new Error("the service did not come back within 240 s");
        await sleep(2_000);
      }
      summary.backAfterMs = Math.round(now() - closedAt);
      return `call closed with ${call.closed?.code}, back after ${summary.backAfterMs} ms`;
    });
    const again = new Wire(`${wsBase.origin}/chat?sessionId=${sessionId}`, origin);
    await check("restart: the session is resumed in chat, with what was said and answered before, and the call is over", async () => {
      await again.opened();
      await waitUntil("the replay", 30_000, () => again.of("syncDone").length > 0);
      const replayed = again.messages.filter((m) => m.msg.type === "message" || m.msg.type === "transcript").length;
      if (replayed < before.messages) throw new Error(`only ${replayed} of ${before.messages} earlier messages came back`);
      if (!again.of("transcript").some((m) => m.msg.role === "agent")) throw new Error("the call's transcript is gone");
      const state = again.of("sessionState").at(-1)?.msg as { status?: string; callActive?: boolean } | undefined;
      if (state?.status !== "active" || state.callActive !== false) throw new Error(`state ${JSON.stringify(state)}`);
      return `${replayed} messages replayed`;
    });
    const record = await finishInChat(again, "restart: the claim completes in chat after the restart");
    await verifyRecord(record);
    await verifyDatabase(1);
    again.close();
    return { results, summary, sessionId };
  }
}

async function waitUntilAsync<T>(timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (now() > deadline) throw new Error("timed out waiting for the receiver row");
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line

async function restartByOperator(): Promise<void> {
  const hook = process.env.RENDER_DEPLOY_HOOK_URL;
  if (hook) {
    const response = await fetch(hook, { method: "POST", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`the deploy hook answered HTTP ${response.status}`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Restart (or Manual Deploy) in the Render dashboard now, then press Enter here… ");
  rl.close();
}

function parseArgs(argv: string[]): { url: URL; restart: boolean; noDb: boolean } {
  const [url, ...rest] = argv;
  if (!url) throw new Error("usage: e2e.ts <base-url> [--restart] [--no-db]");
  const base = new URL(url);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("base URL must be http(s)");
  let restart = false;
  let noDb = false;
  for (const arg of rest) {
    if (arg === "--restart") restart = true;
    else if (arg === "--no-db") noDb = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { url: base, restart, noDb };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { results, summary, sessionId } = await runE2E({
    base: parsed.url,
    restart: parsed.restart,
    noDb: parsed.noDb,
    databaseUrl: process.env.DATABASE_URL ?? null,
    restartService: restartByOperator,
    limits: DEFAULT_LIMITS,
    log: console.log,
  });
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(`\nsession ${sessionId}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (skipped.length) console.log("SKIPPED checks are part of the acceptance: the run is INCOMPLETE.");
  return failed.length || skipped.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`e2e crashed: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
