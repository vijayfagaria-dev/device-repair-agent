// The LLM turn engine (P5-T06): one agent turn = up to MAX_ROUNDS model calls. Each call streams text to the speech
// sink as it arrives and collects tool calls; tool calls are validated (tools.ts) and run through the ToolRunner,
// which dispatches commands, exactly once each; all results go back in one message.
//
// Acknowledge-then-ask (D13, P0-T03): gpt-oss-20b usually answers with tool calls and no speech, often one field per
// call (P5-T01 capture). Then a templated acknowledgement built from the validated results is spoken at once and
// recorded as the agent's words, and the next call runs for the next question while it plays. A follow-up call only
// happens when nothing was said yet or a result was invalid (so the agent can react); otherwise the turn ends.
// Failures: the router has already tried every route (agent/llm.ts); then a filler line is said and the turn is
// marked failed (the call engine ends the call after two in a row). Empty or refused output also counts as refused.
import { type ChatToolCall, type LlmClient, LlmError, type LlmMessage, type LlmRoute, type LlmUsage } from "../voice/types.js";
import { type ParsedToolCall, parseToolCall, TOOLS } from "./tools.js";

export const MAX_ROUNDS = 4;
export const FILLER_LINE = "Sorry, give me a moment. Could you say that again?";
/** Said first when the last-resort route (Gemini) answers, which is slower (D06). */
export const ONE_MOMENT = "One moment.";

export interface ToolOutcome {
  /** What the model is told (JSON). */
  result: Record<string, unknown>;
  /** The call did what was asked. False (invalid value, refused card, needs confirmation) → a follow-up call. */
  ok: boolean;
  /** A short templated acknowledgement of a validated result ("Got it, Samsung Galaxy S23."). */
  ack?: string;
  /** The call ends after this turn's speech (end_call, opt-out). */
  endCall?: boolean;
}

export interface ToolRunner {
  run(call: ParsedToolCall): Promise<ToolOutcome>;
}

export interface TurnSink {
  say(text: string): void;
  /** Speak what has been said so far now, without waiting for more text (a templated line ends here). */
  breakChunk?(): void;
}

export interface TurnInput {
  /** System prompt and this call's conversation so far (no state message). */
  history: readonly LlmMessage[];
  /** A fresh state message for each model call (tool results may have changed it). */
  state: () => Promise<LlmMessage>;
  signal?: AbortSignal;
}

export interface RoundRecord {
  route: LlmRoute;
  usage: LlmUsage | null;
  ttftMs: number | null;
}

export interface TurnOutput {
  /** Everything said, in order (model text and acknowledgements). */
  spoken: string;
  /** What to append to the call's history: assistant messages (with tool calls) and tool results. */
  messages: LlmMessage[];
  rounds: RoundRecord[];
  endCall: boolean;
  /** No route answered: the filler line was said. */
  failed: boolean;
  /** The model gave empty or refused output. */
  refused: boolean;
  aborted: boolean;
  /** Tool calls run, by name (for tests and the timeline). */
  toolsRun: string[];
}

export interface TurnDeps {
  llm: LlmClient;
  tools: ToolRunner;
  /** Each model call as it ends (usage null: aborted before the provider reported it). For the ledger, at once. */
  onRound?: (route: LlmRoute, usage: LlmUsage | null) => void;
}

export async function runTurn(deps: TurnDeps, input: TurnInput, sink: TurnSink): Promise<TurnOutput> {
  const out: TurnOutput = { spoken: "", messages: [], rounds: [], endCall: false, failed: false, refused: false, aborted: false, toolsRun: [] };
  /** Speaks text, separated from what was said before it. */
  const say = (text: string) => {
    if (!text) return;
    const piece = out.spoken && !/\s$/.test(out.spoken) && !/^\s/.test(text) ? ` ${text}` : text;
    sink.say(piece);
    out.spoken += piece;
  };
  let lastAck = "";
  /** The acknowledgement the previous round spoke: a follow-up that starts by repeating it has that part dropped. */
  let justSaid = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (input.signal?.aborted) {
      out.aborted = true;
      break;
    }
    const messages = [...input.history, ...out.messages, await input.state()];
    let stream: Awaited<ReturnType<LlmClient["stream"]>>;
    try {
      stream = await deps.llm.stream({
        messages,
        tools: TOOLS,
        signal: input.signal,
        // The last resort (Gemini) is slower: say so while it works, not after it answered (D06).
        onFallback: (next) => {
          if (next.provider === "gemini" && !out.spoken) {
            say(ONE_MOMENT);
            sink.breakChunk?.();
          }
        },
      });
    } catch (err) {
      const error = err instanceof LlmError ? err : new LlmError(String(err), null);
      if (error.status === "aborted" || input.signal?.aborted) {
        out.aborted = true;
        break;
      }
      out.refused = error.status === "empty";
      // Something was already said this turn: end it there. Otherwise the filler keeps the call alive.
      if (!out.spoken) {
        out.failed = true;
        say(FILLER_LINE);
        out.messages.push({ role: "assistant", content: FILLER_LINE });
      }
      break;
    }
    const record: RoundRecord = { route: stream.route, usage: null, ttftMs: null };
    out.rounds.push(record);

    let text = "";
    const calls: ChatToolCall[] = [];
    let finishReason: string | null = null;
    // Held back while it could still be a repeat of `justSaid` (real gpt-oss-20b runs did repeat it despite the prompt).
    let held = justSaid ? "" : null;
    const emit = (delta: string) => {
      if (!delta) return;
      // Only the round's first piece is separated from earlier speech; later pieces are mid-word tokens.
      if (text === "") say(delta.replace(/^\s+/, ""));
      else {
        sink.say(delta);
        out.spoken += delta;
      }
      text += text === "" ? delta.replace(/^\s+/, "") : delta;
    };
    const release = (final: boolean) => {
      if (held === null) return;
      const lead = held.replace(/^\s+/, "");
      const prefix = justSaid.toLowerCase();
      if (lead.toLowerCase().startsWith(prefix)) {
        held = null;
        emit(lead.slice(prefix.length));
      } else if (final || !prefix.startsWith(lead.toLowerCase())) {
        const all = held;
        held = null;
        emit(all);
      }
    };
    try {
      for await (const chunk of stream) {
        if (input.signal?.aborted) break;
        if (chunk.type === "text") {
          if (held !== null) {
            held += chunk.delta;
            release(false);
          } else emit(chunk.delta);
        } else if (chunk.type === "toolCall") calls.push(chunk.call);
        else if (chunk.type === "usage") record.usage = chunk.usage;
        else if (chunk.type === "done") finishReason = chunk.finishReason;
      }
    } catch {
      // A stream that broke mid-way: keep what was said; the turn ends.
      out.failed = out.spoken === "" && text === "";
    }
    release(true);
    justSaid = "";
    record.ttftMs = stream.ttftMs;
    deps.onRound?.(record.route, record.usage);
    if (input.signal?.aborted) {
      out.aborted = true;
      if (text || calls.length) out.messages.push({ role: "assistant", content: text || null });
      break;
    }
    if (finishReason === "content_filter" && !text && calls.length === 0) out.refused = true;

    if (calls.length === 0) {
      if (text.trim()) out.messages.push({ role: "assistant", content: text });
      else if (!out.spoken) {
        out.refused = true;
        out.failed = true;
        say(FILLER_LINE);
        out.messages.push({ role: "assistant", content: FILLER_LINE });
      }
      break;
    }

    // Each call is run exactly once, in order; invalid ones get an error result and no effect.
    const outcomes: ToolOutcome[] = [];
    for (const call of calls) {
      const parsed = parseToolCall(call.name, call.arguments);
      if (!parsed.ok) {
        outcomes.push({ result: { status: "error", error: parsed.error }, ok: false });
        continue;
      }
      out.toolsRun.push(parsed.call.name);
      outcomes.push(await deps.tools.run(parsed.call));
    }
    let content = text.trim() ? text : null;
    if (!content) {
      const acks = [...new Set(outcomes.filter((o) => o.ok && o.ack).map((o) => o.ack as string))].slice(0, 2);
      const ack = outcomes.every((o) => o.ok) ? acks.join(" ") : "";
      if (ack && ack !== lastAck) {
        say(ack);
        sink.breakChunk?.(); // spoken now, while the follow-up call runs (acknowledge-then-ask)
        lastAck = ack;
        justSaid = ack;
        content = ack;
      }
    }
    out.messages.push({ role: "assistant", content, toolCalls: calls });
    calls.forEach((call, i) => {
      out.messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcomes[i]?.result ?? {}) });
    });
    if (outcomes.some((o) => o.endCall)) {
      out.endCall = true;
      break;
    }
    const needFollowUp = !text.trim() || outcomes.some((o) => !o.ok);
    if (!needFollowUp) break;
  }
  return out;
}
