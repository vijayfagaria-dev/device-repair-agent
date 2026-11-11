// Deepgram Aura-2 streaming TTS adapter (P5-T04, D05): one WebSocket per call to `speak` (linear16, 24 kHz), opened
// at call start. Per chunk: `Speak` then `Flush`; Deepgram answers with audio frames, then `Flushed`.
//
// Barge-in (P0-T03): `Clear` does not stop audio quickly (1.1–2.2 s still arrived after it), so cancel() stops
// emitting the turn's audio at once and drops every frame until `Cleared`; speech for a later turn waits for it. If
// `Cleared` doesn't come within 1 s, the socket is closed and a new one opened. A socket that drops mid-chunk is
// reopened once and the unfinished chunks are sent again (failure matrix: retry a chunk once).
import WebSocket from "ws";
import type { Secret } from "../config.js";
import type { TtsProvider, TtsStream } from "./types.js";

export const DEEPGRAM_SPEAK_URL = "wss://api.deepgram.com/v1/speak";
export const TTS_SAMPLE_RATE = 24_000;

export interface DeepgramTtsOptions {
  apiKey: Secret;
  url?: string;
  voice?: string;
  /** How long to wait for `Cleared` before reopening the socket. */
  clearTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export const deepgramSpeakUrl = (base: string, voice: string) => `${base}?model=${encodeURIComponent(voice)}&encoding=linear16&sample_rate=${TTS_SAMPLE_RATE}`;

/** A flushed chunk in flight: its turn and text (kept to resend once if the socket drops). */
interface Segment {
  turnId: string;
  text: string;
}

export function createDeepgramTts(options: DeepgramTtsOptions): TtsProvider {
  const url = deepgramSpeakUrl(options.url ?? DEEPGRAM_SPEAK_URL, options.voice ?? "aura-2-thalia-en");
  const clearTimeoutMs = options.clearTimeoutMs ?? 1_000;

  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Token ${options.apiKey.reveal()}` } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Deepgram TTS connect timed out"));
      }, options.connectTimeoutMs ?? 5_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  return {
    async open(onEvent) {
      let ws = await connect();
      let closing = false;
      let retried = false;
      /** Chunks flushed and not yet `Flushed`, oldest first; audio belongs to the first. */
      let inFlight: Segment[] = [];
      /** Text spoken for the next chunk (before its Flush). */
      const pendingText = new Map<string, string>();
      const cancelled = new Set<string>();
      /** While a Clear is outstanding: frames are dropped and new speech waits here. */
      let clearing: { timer: NodeJS.Timeout; waiting: (() => void)[]; reopening?: boolean } | null = null;

      const send = (message: object) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      const sendChunk = (segment: Segment) => {
        inFlight.push(segment);
        send({ type: "Speak", text: segment.text });
        send({ type: "Flush" });
      };
      const whenClear = (action: () => void) => (clearing ? clearing.waiting.push(action) : action());
      const endClearing = () => {
        if (!clearing) return;
        clearTimeout(clearing.timer);
        const waiting = clearing.waiting;
        clearing = null;
        inFlight = [];
        for (const action of waiting) action();
      };

      const attach = (socket: WebSocket) => {
        socket.on("message", (data, isBinary) => {
          if (socket !== ws) return; // a replaced socket's late frames
          if (isBinary) {
            const segment = inFlight[0];
            if (clearing || !segment || cancelled.has(segment.turnId)) return;
            onEvent({ type: "audio", turnId: segment.turnId, pcm: Buffer.from(data as Buffer), sampleRate: TTS_SAMPLE_RATE });
            return;
          }
          let message: { type?: string };
          try {
            message = JSON.parse(String(data));
          } catch {
            return;
          }
          if (message.type === "Flushed") {
            const segment = inFlight.shift();
            retried = false;
            // One event per chunk (TtsEvent "flushed"), never for a cancelled turn.
            if (segment && !cancelled.has(segment.turnId) && !clearing) onEvent({ type: "flushed", turnId: segment.turnId });
          } else if (message.type === "Cleared") {
            // Too late once a fresh socket is on its way: the waiting speech goes there.
            if (!clearing?.reopening) endClearing();
          }
        });
        socket.on("close", () => {
          if (socket !== ws || closing) return;
          // Dropped by the provider. Reopen once and resend what wasn't spoken yet; otherwise report the failure.
          const unfinished = inFlight.filter((s) => !cancelled.has(s.turnId));
          inFlight = [];
          if (clearing) {
            // Still clearing: keep dropping frames and holding new speech until the new socket is ready.
            clearing.reopening = true;
            void reopen([]).then(endClearing);
          } else if (!retried && unfinished.length > 0) {
            retried = true;
            void reopen(unfinished);
          } else if (unfinished.length > 0) {
            onEvent({ type: "error", error: new Error("Deepgram TTS connection lost") });
          } else {
            void reopen([]);
          }
        });
        socket.on("error", () => {}); // a close follows
      };

      const reopen = async (resend: Segment[]) => {
        const old = ws;
        try {
          ws = await connect();
        } catch (error) {
          onEvent({ type: "error", error: error as Error });
          return;
        }
        attach(ws);
        if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) old.terminate();
        for (const segment of resend) sendChunk(segment);
      };

      attach(ws);
      const stream: TtsStream = {
        speak(turnId, text) {
          if (cancelled.has(turnId) || !text) return;
          pendingText.set(turnId, `${pendingText.get(turnId) ?? ""}${text}`);
        },
        flush(turnId) {
          const text = pendingText.get(turnId);
          pendingText.delete(turnId);
          if (!text || cancelled.has(turnId)) return;
          whenClear(() => {
            if (!cancelled.has(turnId)) sendChunk({ turnId, text });
          });
        },
        cancel(turnId) {
          cancelled.add(turnId);
          pendingText.delete(turnId);
          if (!inFlight.some((s) => s.turnId === turnId) || clearing) return;
          send({ type: "Clear" });
          clearing = {
            waiting: [],
            timer: setTimeout(() => {
              // No Cleared: start over on a fresh socket. `clearing` stays set until it is open, so the old socket's
              // late frames are dropped and new speech waits for the new one (P5 review #6).
              if (clearing) clearing.reopening = true;
              void reopen([]).then(endClearing);
            }, clearTimeoutMs),
          };
        },
        async close() {
          closing = true;
          if (clearing) clearTimeout(clearing.timer);
          const socket = ws;
          if (socket.readyState !== WebSocket.OPEN) {
            socket.terminate();
          } else {
            await new Promise<void>((done) => {
              const force = setTimeout(() => {
                socket.terminate();
                done();
              }, 1_000);
              socket.once("close", () => {
                clearTimeout(force);
                done();
              });
              socket.send(JSON.stringify({ type: "Close" }));
            });
          }
          onEvent({ type: "closed" });
        },
      };
      return stream;
    },
  };
}
