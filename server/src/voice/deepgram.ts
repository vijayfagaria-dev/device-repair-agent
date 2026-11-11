// Deepgram streaming STT adapter (P5-T03, D04): one WebSocket per call to `listen`, with the options measured in
// P0-T03 (nova-3-general, linear16 16 kHz, interim results, endpointing 150 ms, utterance_end_ms 1000, VAD events).
// It only translates Deepgram's messages into SttEvents; utterances and turn ends are voice/userTurns.ts's.
import WebSocket from "ws";
import type { Secret } from "../config.js";
import type { SttEvent, SttProvider, SttStream } from "./types.js";

export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramSttOptions {
  apiKey: Secret;
  /** Tests point this at a local mock server. */
  url?: string;
  endpointingMs?: number;
  /** Deepgram closes a stream after ~10 s without data; a KeepAlive goes out after this long without audio. */
  keepAliveMs?: number;
  connectTimeoutMs?: number;
}

export function deepgramListenUrl(base: string, endpointingMs: number): string {
  const params = new URLSearchParams({
    model: "nova-3-general",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    endpointing: String(endpointingMs),
    utterance_end_ms: "1000",
    vad_events: "true",
    smart_format: "true",
    punctuate: "true",
  });
  return `${base}?${params}`;
}

/** One Deepgram message → the event it means, or null (Metadata and anything unknown). */
export function toSttEvent(message: unknown): SttEvent | null {
  const m = message as { type?: unknown; is_final?: unknown; speech_final?: unknown; channel?: { alternatives?: { transcript?: unknown }[] } };
  switch (m?.type) {
    case "SpeechStarted":
      return { type: "speechStarted" };
    case "UtteranceEnd":
      return { type: "utteranceEnd" };
    case "Results": {
      const text = m.channel?.alternatives?.[0]?.transcript;
      return { type: "transcript", text: typeof text === "string" ? text : "", isFinal: m.is_final === true, speechFinal: m.speech_final === true };
    }
    default:
      return null;
  }
}

export function createDeepgramStt(options: DeepgramSttOptions): SttProvider {
  const url = deepgramListenUrl(options.url ?? DEEPGRAM_LISTEN_URL, options.endpointingMs ?? 150);
  const keepAliveMs = options.keepAliveMs ?? 8_000;
  return {
    open(onEvent) {
      return new Promise<SttStream>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { Authorization: `Token ${options.apiKey.reveal()}` } });
        let opened = false;
        let closed = false;
        let lastSent = Date.now();
        const connectTimer = setTimeout(() => {
          ws.terminate();
          reject(new Error("Deepgram STT connect timed out"));
        }, options.connectTimeoutMs ?? 5_000);
        const keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && Date.now() - lastSent >= keepAliveMs) {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
            lastSent = Date.now();
          }
        }, 1_000);
        keepAlive.unref();
        const finish = () => {
          clearInterval(keepAlive);
          clearTimeout(connectTimer);
        };

        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(data));
          } catch {
            return;
          }
          const event = toSttEvent(parsed);
          if (event) onEvent(event);
        });
        ws.on("error", (error) => {
          if (!opened) {
            finish();
            reject(error);
            return;
          }
          onEvent({ type: "error", error });
        });
        ws.on("close", () => {
          finish();
          if (!opened) {
            reject(new Error("Deepgram STT closed before opening"));
            return;
          }
          if (!closed) {
            closed = true;
            onEvent({ type: "closed" });
          }
        });
        ws.on("open", () => {
          opened = true;
          clearTimeout(connectTimer);
          resolve({
            push(pcm) {
              if (ws.readyState !== WebSocket.OPEN) return;
              ws.send(pcm);
              lastSent = Date.now();
            },
            close() {
              return new Promise<void>((done) => {
                if (ws.readyState === WebSocket.CLOSED) return done();
                const force = setTimeout(() => ws.terminate(), 2_000);
                force.unref();
                ws.once("close", () => {
                  clearTimeout(force);
                  done();
                });
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
                else ws.terminate();
              });
            },
          });
        });
      });
    },
  };
}
