// P11-T02: the call socket's messages feed the probe, and a sample leaves through the sink useChat registers.
import { CallServerMessageType, type ClientMetric, Role } from "@device-repair/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Ui } from "../src/state/ui";

vi.mock("../src/config", () => ({ sessionId: "00000000-0000-4000-8000-000000000000" }));
vi.mock("../src/audio/playback", () => ({ playPcm16: vi.fn(() => 250), stopPlayback: vi.fn() }));
const { latencyProbe, registerMetricSink } = await import("../src/audio/latencyProbe");
const { handleCallMessage } = await import("../src/transport/callMessages");

const ui = { addTranscript: vi.fn() } as unknown as Ui;
const agentLine = JSON.stringify({ type: CallServerMessageType.TRANSCRIPT, id: "ta_c1_2", role: Role.AGENT, text: "Got it.", final: false });
const audio = JSON.stringify({ type: CallServerMessageType.AUDIO, data: "AAAA", sampleRate: 24000 });

function speak(speechMs: number, quietMs: number) {
  // The mic frames happened just before now: the speech ended, then the quiet lasted quietMs.
  const start = performance.now() - speechMs - quietMs;
  for (let t = 0; t < speechMs; t += 20) latencyProbe.onMicLevel(0.2, start + t);
  for (let t = 0; t < quietMs; t += 20) latencyProbe.onMicLevel(0, start + speechMs + t);
}

describe("call messages → latency probe", () => {
  it("an agent line then audio after the user's speech sends one clientMetric through the registered sink", () => {
    const sent: ClientMetric[] = [];
    const unregister = registerMetricSink((m) => sent.push(m));
    latencyProbe.reset();
    speak(500, 600);
    handleCallMessage(ui, agentLine);
    handleCallMessage(ui, audio);
    handleCallMessage(ui, audio);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "turnLatency", turnId: "ta_c1_2" });
    expect(sent[0]?.ms).toBeGreaterThan(0);
    unregister();
  });

  it("without a sink (demo mode, a closed chat socket) samples are dropped quietly", () => {
    latencyProbe.reset();
    speak(500, 600);
    expect(() => {
      handleCallMessage(ui, agentLine);
      handleCallMessage(ui, audio);
    }).not.toThrow();
  });

  it("a user line never names a turn", () => {
    const sent: ClientMetric[] = [];
    const unregister = registerMetricSink((m) => sent.push(m));
    latencyProbe.reset();
    speak(500, 600);
    handleCallMessage(ui, JSON.stringify({ type: CallServerMessageType.TRANSCRIPT, id: "tu_c1_1", role: Role.USER, text: "hi", final: true }));
    handleCallMessage(ui, audio);
    expect(sent).toEqual([]);
    unregister();
  });
});
