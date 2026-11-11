// The call engine (P5-T07…T12, architecture §6): one per live call. It wires the user's speech (STT → utterances →
// transcript lines and turn ends), the agent's turns (turn engine → speech out → audio and the agent line), the
// agent's tools (as commands) and the session's chat events, and it owns every way a call ends.
//
// - One agent turn at a time. A user utterance that ends while the agent is still thinking replaces that turn.
// - Barge-in (P5-T07): confirmed speech while the agent is audible → stopPlayback FIRST, then the LLM is aborted, TTS
//   cancelled, and the agent line and history are truncated at what was heard, marked [interrupted]. Tool calls already
//   committed stay.
// - Chat events (P5-T08) from the hub are batched into the next state message; when nobody is speaking for 1.2 s a
//   proactive turn acknowledges them. Voice help is offered after 2+ rejections (the state carries the count).
// - Endings (P5-T09/T10): the agent's end_call (after its goodbye has played), the user hanging up, a dropped
//   socket, silence (reprompts at 8 s and 16 s, end at 24 s, suspended for 30 s after a chat card opens), the maximum
//   duration, provider failure, an opt-out (by voice or from the chat). Every path ends the call exactly once
//   (EndCall), and the chat takes over (P4 planner).
// - A returning call (P5-T12) greets with what's collected: the state says isReturningCall and the last question.
import type { RecordFieldId } from "@device-repair/shared/fields";
import { CallServerMessageType, CloseCode, Role } from "@device-repair/shared/protocol";
import type { FastifyBaseLogger } from "fastify";
import { isRecordField } from "../agent/chatPlanner.js";
import { systemMessage } from "../agent/prompt.js";
import { type ChatEventNote, stateMessage } from "../agent/stateMessage.js";
import type { ParsedToolCall } from "../agent/tools.js";
import { groundingError } from "../agent/grounding.js";
import { runTurn, type ToolOutcome, type ToolRunner } from "../agent/turnEngine.js";
import { cardSentAck, OPTED_OUT_GOODBYE, PROVIDER_TROUBLE, REPROMPTS, SUBMITTED_GOODBYE, savedAck, typeItAck } from "../agent/voiceTemplates.js";
import { buildTurnMetric } from "../metrics/latency.js";
import type { SessionUpdate } from "../session/hub.js";
import type { CallEndReason, SaveSpokenFieldReply } from "../session/handlers/call.js";
import type { RequestInputReply } from "../session/handlers/requestInput.js";
import { type BargeInSettings, DEFAULT_BARGE_IN, shouldBargeIn } from "./bargeIn.js";
import type { CallSessionPort } from "./callSession.js";
import type { Clock } from "./clock.js";
import { type CallMessage, INTERRUPTED_MARK, SpeechTurn, type SpokenTurn } from "./speechOut.js";
import type { LlmClient, LlmMessage, SttEvent, SttProvider, SttStream, TtsEvent, TtsProvider, TtsStream } from "./types.js";
import { pcmBytesPerSecond } from "./types.js";
import { type Utterance, UserTurns } from "./userTurns.js";

export interface CallTimings {
  /** Words within this long after speech_final join the same user turn. */
  mergeMs: number;
  silenceMs: number;
  /** Reprompts before a silent call ends (PD3: 2, so the call ends at 3 × silenceMs). */
  silenceReprompts: number;
  /** Nobody speaking for this long → a proactive turn for new chat events (P5-T08). */
  proactiveIdleMs: number;
  /** Silence isn't counted for this long after a chat card opened (the user is busy typing, P5-T10). */
  cardSuspendMs: number;
  maxCallMs: number;
  /** The planner's 60 s safety net runs at this point of the call (P4-T01). */
  safetyNetMs: number;
}

export const DEFAULT_CALL_TIMINGS: CallTimings = {
  mergeMs: 300,
  silenceMs: 8_000,
  silenceReprompts: 2,
  proactiveIdleMs: 1_200,
  cardSuspendMs: 30_000,
  maxCallMs: 10 * 60_000,
  safetyNetMs: 61_000,
};

export interface CallEngineOptions {
  callId: string;
  port: CallSessionPort;
  stt: SttProvider;
  tts: TtsProvider;
  llm: LlmClient;
  clock: Clock;
  log: FastifyBaseLogger;
  /** Sends to the browser's call socket. */
  send(message: CallMessage): void;
  /** Closes the call socket (the engine decided the call is over). */
  close(code: number, reason: string): void;
  /** This call follows earlier ones on the session (StartCall's reply). */
  returning: boolean;
  timings?: Partial<CallTimings>;
  bargeIn?: BargeInSettings;
}

interface AgentTurn {
  id: string;
  speech: SpeechTurn;
  abort: AbortController;
  userEndAt: number | null;
  /** STT's end-of-utterance event → this turn starting (the merge window); null for a turn no utterance caused. */
  sttMs: number | null;
  running: Promise<void>;
}

const MIC_BYTES_PER_SECOND = pcmBytesPerSecond(16_000);
/** The longest an agent turn may take to play out before it is cancelled (a provider that never finishes). */
export const TURN_WATCHDOG_MS = 45_000;

export class CallEngine {
  readonly #o: CallEngineOptions;
  readonly #t: CallTimings;
  readonly #startedAt: number;
  readonly #history: LlmMessage[] = [];
  readonly #userTurns: UserTurns;
  readonly #tools: ToolRunner;
  #stt!: SttStream;
  #tts!: TtsStream;
  #sttRetried = false;
  #turn: AgentTurn | null = null;
  #turnCount = 0;
  /** Turn requests so far: only the newest one runs once the previous turn is done (P5 review #1). */
  #turnGen = 0;
  /** User utterances not yet in the history: the next turn that runs takes them all, in order. */
  readonly #pendingUser: string[] = [];
  /** STT streams opened: events from a replaced stream are ignored (its error and close are one failure, #2). */
  #sttGen = 0;
  #failures = 0;
  #pending: ChatEventNote[] = [];
  readonly #rejections = new Map<string, number>();
  #lastCardAt = -Infinity;
  #reprompts = 0;
  #silenceTimer: unknown = null;
  #proactiveTimer: unknown = null;
  #bargeTimer: unknown = null;
  readonly #timers: unknown[] = [];
  #unsubscribe: (() => void) | null = null;
  #sttBytes = 0;
  #ending: Promise<void> | null = null;
  /** Set first thing when the call ends, before any provider is closed (their close events must not look unexpected). */
  #stopping = false;
  #resolveEnded!: () => void;
  /** Resolves once the call has fully ended (EndCall done). */
  readonly #endedPromise = new Promise<void>((resolve) => {
    this.#resolveEnded = resolve;
  });
  /** This engine finalized the session itself (opt_out): the hub's session.finalized needs no goodbye. */
  #selfFinalized = false;
  /** Barge-ins this call (for the log and tests). */
  bargeIns = 0;

  private constructor(options: CallEngineOptions) {
    this.#o = options;
    this.#t = { ...DEFAULT_CALL_TIMINGS, ...options.timings };
    this.#startedAt = options.clock.now();
    this.#userTurns = new UserTurns({
      callId: options.callId,
      clock: options.clock,
      mergeMs: this.#t.mergeMs,
      onLine: (line) => this.#onUserLine(line),
      onTurnEnd: (utterance) => this.#onUserTurnEnd(utterance),
      onSpeechStarted: () => this.#onSpeechStarted(),
      onSpeechAbandoned: () => {
        if (!this.#stopping && !this.#turn) this.#armSilence();
      },
    });
    this.#tools = { run: (call) => this.#runTool(call) };
  }

  /** Opens the providers and greets. Rejects (after ending the call) if a provider can't be opened. */
  static async start(options: CallEngineOptions): Promise<CallEngine> {
    const engine = new CallEngine(options);
    await engine.#begin();
    return engine;
  }

  get callId(): string {
    return this.#o.callId;
  }

  get ended(): boolean {
    return this.#stopping;
  }

  /** Resolves when the call has fully ended (not before it has started ending). */
  get whenEnded(): Promise<void> {
    return this.#endedPromise;
  }

  async #begin(): Promise<void> {
    // Both at once: each is a WebSocket handshake to the provider (~1 s from far away).
    const gen = ++this.#sttGen;
    const [stt, tts] = await Promise.allSettled([this.#o.stt.open((event) => this.#onStt(event, gen)), this.#o.tts.open((event) => this.#onTts(event))]);
    if (stt.status === "rejected" || tts.status === "rejected") {
      // Whichever did open is closed again (P5 review #11).
      if (stt.status === "fulfilled") await stt.value.close().catch(() => {});
      if (tts.status === "fulfilled") await tts.value.close().catch(() => {});
      const err = (stt.status === "rejected" ? stt.reason : (tts as PromiseRejectedResult).reason) as Error;
      this.#o.log.error({ message: err.message }, "call providers unavailable");
      await this.#end("provider_error", { code: CloseCode.NORMAL, reason: "call ended" });
      throw err;
    }
    this.#stt = stt.value;
    this.#tts = tts.value;
    this.#unsubscribe = this.#o.port.subscribe((update) => this.#onSessionUpdate(update));
    this.#timers.push(this.#o.clock.setTimeout(() => void this.#end("max_duration", { code: CloseCode.NORMAL, reason: "max duration" }), this.#t.maxCallMs));
    this.#timers.push(this.#o.clock.setTimeout(() => void this.#o.port.reconcile().catch(() => {}), this.#t.safetyNetMs));
    void this.#agentTurn({ opening: this.#o.returning ? "(The customer called back.)" : "(The call has just connected.)" });
  }

  /** One mic frame (20 ms PCM16 at 16 kHz). */
  pushAudio(pcm: Buffer): void {
    if (this.#stopping) return;
    this.#sttBytes += pcm.length;
    this.#stt.push(pcm);
  }

  /** The socket closed (the user hung up, the network dropped, the server is restarting). */
  stop(reason: CallEndReason): Promise<void> {
    return this.#end(reason, null);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The user

  #onStt(event: SttEvent, gen: number): void {
    if (this.#stopping || gen !== this.#sttGen) return;
    if (event.type === "error" || event.type === "closed") {
      void this.#sttFailed(event.type === "error" ? event.error : new Error("STT closed"));
      return;
    }
    this.#userTurns.handle(event);
    if (event.type === "transcript") this.#checkBargeIn();
  }

  async #sttFailed(error: Error): Promise<void> {
    if (this.#stopping) return;
    // The failed stream is done with: its remaining events (ws sends close after error) are ignored.
    const gen = ++this.#sttGen;
    if (!this.#sttRetried) {
      // Reconnect once (failure matrix); the user hears nothing of it.
      this.#sttRetried = true;
      this.#o.log.warn({ message: error.message }, "STT stream failed; reconnecting once");
      try {
        const stream = await this.#o.stt.open((event) => this.#onStt(event, gen));
        if (this.#stopping) {
          await stream.close().catch(() => {}); // the call ended meanwhile
          return;
        }
        this.#stt = stream;
        return;
      } catch {
        // fall through
      }
    }
    this.#o.log.error({ message: error.message }, "STT unavailable; ending the call");
    await this.#sayTemplated(PROVIDER_TROUBLE);
    await this.#end("provider_error", { code: CloseCode.NORMAL, reason: "call ended" });
  }

  #onSpeechStarted(): void {
    // Silence pauses; it re-arms if this turns out to be no words (onSpeechAbandoned). Reprompts reset only on words.
    this.#clearSilence();
    // The duration path of the barge-in rule needs a check once the speech has lasted long enough.
    if (this.#bargeTimer !== null) this.#o.clock.clearTimeout(this.#bargeTimer);
    this.#bargeTimer = this.#o.clock.setTimeout(() => {
      this.#bargeTimer = null;
      this.#checkBargeIn();
    }, (this.#o.bargeIn ?? DEFAULT_BARGE_IN).minSpeechMs);
  }

  #onUserLine(line: { id: string; text: string; final: boolean }): void {
    this.#o.send({ type: CallServerMessageType.TRANSCRIPT, id: line.id, role: Role.USER, text: line.text, final: line.final });
    if (line.text) this.#reprompts = 0;
    if (line.final && line.text) {
      this.#dispatchQuietly({ type: "AppendTranscript", line: { id: line.id, callId: this.#o.callId, role: Role.USER, text: line.text, startedAt: new Date(this.#o.clock.now()) } });
    }
  }

  #onUserTurnEnd(utterance: Utterance): void {
    if (this.#stopping) return;
    this.#reprompts = 0;
    const turn = this.#turn;
    // The user finished speaking while the agent was still on its turn: their words win (an interruption if heard).
    if (turn) {
      if (turn.speech.audible && turn.speech.speaking) this.#bargeIn(turn);
      else {
        // Nothing heard yet: drop it quietly, so its queued speech doesn't play first (P5 review #5).
        turn.abort.abort();
        turn.speech.cancel();
      }
    }
    void this.#agentTurn({ userText: utterance.text, userEndAt: utterance.endEventAt, sttMs: utterance.endedAt - utterance.endEventAt });
  }

  #checkBargeIn(): void {
    const turn = this.#turn;
    if (!turn || this.#stopping) return;
    const facts = {
      agentAudibleSince: turn.speech.firstAudioAt,
      agentSpeaking: turn.speech.speaking,
      userSpeechSince: this.#userTurns.speechStartedAt,
      words: this.#userTurns.words,
      now: this.#o.clock.now(),
    };
    if (shouldBargeIn(facts, this.#o.bargeIn ?? DEFAULT_BARGE_IN)) this.#bargeIn(turn);
  }

  /** Stops the agent at once: stopPlayback first (the user-audible stop doesn't wait for any provider). */
  #bargeIn(turn: AgentTurn): void {
    if (!turn.speech.speaking) return;
    this.#o.send({ type: CallServerMessageType.STOP_PLAYBACK });
    turn.speech.cancel();
    turn.abort.abort();
    this.bargeIns += 1;
    this.#o.log.info({ turnId: turn.id }, "barge-in");
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The agent

  async #agentTurn(input: { userText?: string; userEndAt?: number; sttMs?: number; opening?: string; proactive?: boolean }): Promise<void> {
    if (this.#stopping) return;
    this.#clearSilence();
    this.#clearProactive();
    if (input.userText) this.#pendingUser.push(input.userText);
    else if (input.opening) this.#pendingUser.push(input.opening);
    const gen = ++this.#turnGen;
    const previous = this.#turn;
    if (previous) {
      previous.abort.abort();
      await previous.running.catch(() => {});
    }
    // A newer request arrived while waiting: it runs instead, with every utterance (one agent turn at a time).
    if (this.#stopping || gen !== this.#turnGen) return;
    for (const content of this.#pendingUser.splice(0)) this.#history.push({ role: "user", content });
    const notes = this.#pending.splice(0);
    const id = `ta_${this.#o.callId}_${++this.#turnCount}`;
    const speech = new SpeechTurn(id, this.#tts, this.#o.clock, (message) => this.#o.send(message));
    const turn: AgentTurn = { id, speech, abort: new AbortController(), userEndAt: input.userEndAt ?? null, sttMs: input.sttMs ?? null, running: Promise.resolve() };
    this.#turn = turn;
    turn.running = this.#runAgentTurn(turn, notes).catch((err) => {
      this.#o.log.error({ message: (err as Error).message }, "agent turn failed");
      this.#recordTurnMetric(turn, null, null); // a reply to a user utterance still gets its row
    });
    await turn.running;
  }

  async #runAgentTurn(turn: AgentTurn, notes: ChatEventNote[]): Promise<void> {
    const out = await runTurn(
      {
        llm: this.#o.llm,
        tools: this.#tools,
        // Charged as each call ends, not after playback (P5 review #16); an aborted call still counts as a request.
        onRound: (route, usage) => void (usage ? this.#o.port.recordLlmUsage(route, usage) : this.#o.port.recordLlmRequest(route)),
      },
      { history: [systemMessage(), ...this.#history], state: () => this.#state(notes), signal: turn.abort.signal },
      { say: (text) => turn.speech.say(text), breakChunk: () => turn.speech.breakChunk() },
    );
    turn.speech.end();
    // Until the user has heard it all (or interrupted it): barge-in stays possible, and silence counts from here.
    const spoken = await this.#playedOut(turn);
    this.#afterAgentTurn(turn, spoken, out.messages);
    // Chat events this turn never got to mention go back for the next one (P5 review #8).
    if (!spoken.heard && (out.aborted || spoken.interrupted)) this.#restoreNotes(notes);
    if (spoken.characters > 0) void this.#o.port.recordTtsCharacters(spoken.characters);
    this.#recordTurnMetric(turn, spoken, out.rounds[0]?.ttftMs ?? null);
    if (out.refused) this.#dispatchQuietly({ type: "FlagForReview", kind: "other", reason: "the call agent gave no usable reply" });
    if (this.#turn === turn) this.#turn = null;
    if (this.#stopping) return;

    this.#failures = out.failed ? this.#failures + 1 : 0;
    if (this.#failures >= 2) {
      await this.#end("provider_error", { code: CloseCode.NORMAL, reason: "call ended" });
      return;
    }
    if (out.endCall) {
      // The goodbye has played (speech.done): now close (P5-T09).
      await this.#end(this.#selfFinalized ? "opted_out" : "agent_ended", { code: CloseCode.NORMAL, reason: "agent ended" });
      return;
    }
    if (!spoken.interrupted) this.#armSilence();
    if (this.#pending.length > 0) this.#scheduleProactive();
  }

  /** The turn's latency row (P11-T02, D20). Never fails the call: the port logs a write error. */
  #recordTurnMetric(turn: AgentTurn, spoken: SpokenTurn | null, llmTtftMs: number | null): void {
    const metric = buildTurnMetric({
      turnId: turn.id,
      callId: this.#o.callId,
      userEndAt: turn.userEndAt,
      firstAudioAt: spoken?.firstAudioAt ?? null,
      sttMs: turn.sttMs,
      llmTtftMs,
      ttsTtfbMs: spoken?.ttsTtfbMs ?? null,
    });
    if (metric) void this.#o.port.recordTurnMetric(metric);
  }

  /** Waits for the turn to play out, at most TURN_WATCHDOG_MS (a provider that never finishes can't hang the call). */
  async #playedOut(turn: AgentTurn): Promise<SpokenTurn> {
    const timer = this.#o.clock.setTimeout(() => {
      this.#o.log.warn({ turnId: turn.id }, "agent turn didn't finish playing; cancelled");
      turn.speech.cancel();
    }, TURN_WATCHDOG_MS);
    try {
      return await turn.speech.playedOut();
    } finally {
      this.#o.clock.clearTimeout(timer);
    }
  }

  #restoreNotes(notes: ChatEventNote[]): void {
    for (const note of notes) if (!this.#pending.some((n) => n.field === note.field)) this.#pending.unshift(note);
  }

  /** History and transcript after a turn: an interrupted line is cut to what the user heard (P5-T07). */
  #afterAgentTurn(turn: AgentTurn, spoken: SpokenTurn, messages: LlmMessage[]): void {
    if (spoken.interrupted) {
      const heard = `${spoken.heard}${INTERRUPTED_MARK}`.trim();
      // The heard text covers the whole turn (acknowledgements included): it goes on the last assistant message
      // and the earlier ones keep only their tool calls, so nothing appears twice (P5 review #13).
      const assistants = messages.filter((m): m is Extract<LlmMessage, { role: "assistant" }> => m.role === "assistant");
      for (const m of assistants) m.content = null;
      const lastAssistant = assistants.at(-1);
      if (lastAssistant) lastAssistant.content = heard;
      else messages.push({ role: "assistant", content: heard });
      this.#history.push(...messages);
      if (spoken.heard) this.#appendAgentLine(turn.id, heard, true);
      return;
    }
    this.#history.push(...messages);
    if (spoken.text) this.#appendAgentLine(turn.id, spoken.text, false);
  }

  #appendAgentLine(id: string, text: string, interrupted: boolean): void {
    this.#dispatchQuietly({ type: "AppendTranscript", line: { id, callId: this.#o.callId, role: Role.AGENT, text, interrupted, startedAt: new Date(this.#o.clock.now()) } });
  }

  /** A templated line (reprompt, provider notice, goodbye): spoken and recorded like a turn, without the model. */
  async #sayTemplated(text: string): Promise<void> {
    if (!this.#tts) return;
    const gen = ++this.#turnGen;
    const previous = this.#turn;
    if (previous) {
      previous.abort.abort();
      await previous.running.catch(() => {});
    }
    if (gen !== this.#turnGen) return;
    const id = `ta_${this.#o.callId}_${++this.#turnCount}`;
    const speech = new SpeechTurn(id, this.#tts, this.#o.clock, (message) => this.#o.send(message));
    const turn: AgentTurn = { id, speech, abort: new AbortController(), userEndAt: null, sttMs: null, running: Promise.resolve() };
    this.#turn = turn;
    speech.say(text);
    speech.end();
    turn.running = this.#playedOut(turn).then((spoken) => {
      this.#afterAgentTurn(turn, spoken, [{ role: "assistant", content: text }]);
      if (spoken.characters > 0) void this.#o.port.recordTtsCharacters(spoken.characters);
      if (this.#turn === turn) this.#turn = null;
    });
    await turn.running;
  }

  async #state(notes: ChatEventNote[]): Promise<LlmMessage> {
    const ctx = await this.#o.port.context(this.#o.callId);
    const withCounts = notes.map((note) => ({ ...note, rejections: this.#rejections.get(note.field) ?? 0 }));
    return stateMessage({
      now: new Date(this.#o.clock.now()),
      callStartedAt: this.#startedAt,
      session: ctx.session,
      fields: ctx.fields,
      requests: ctx.requests,
      isReturningCall: this.#o.returning,
      lastAgentLine: ctx.lastAgentLineBefore,
      newChatEvents: withCounts,
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Tools → commands (exactly once each; the turn engine runs them in order)

  async #runTool(call: ParsedToolCall): Promise<ToolOutcome> {
    const { port } = this.#o;
    switch (call.name) {
      case "save_field": {
        // Only what the customer really said (agent/grounding.ts): a made-up value never reaches the session.
        const said = this.#history.filter((m): m is Extract<LlmMessage, { role: "user" }> => m.role === "user").map((m) => m.content);
        const ungrounded = groundingError(call.args.spoken_evidence, said);
        if (ungrounded) return { result: { status: "rejected", error: ungrounded }, ok: false };
        const reply = await port.dispatch<SaveSpokenFieldReply>({ type: "SaveSpokenField", field: call.args.field, value: call.args.value, evidence: call.args.spoken_evidence, userConfirmed: call.args.user_confirmed });
        const field = call.args.field as RecordFieldId;
        if (reply?.status === "valid") return { result: { status: "valid" }, ok: true, ack: savedAck(field, reply.normalized) };
        if (reply?.status === "unverified") {
          // Heard, but it must be typed (D13): the card goes to the chat at once.
          const card = await port.dispatch<RequestInputReply>({ type: "RequestInput", field });
          if (card?.status === "queued" || card?.status === "alreadyPending") this.#lastCardAt = this.#o.clock.now();
          return { result: { status: "heardButMustBeTyped", chatCard: card?.status ?? "unknown" }, ok: true, ack: typeItAck(field) };
        }
        if (reply?.status === "invalid") return { result: { status: "invalid", error: reply.error }, ok: false };
        return { result: { status: "refused", reason: reply?.status === "refused" ? reply.reason : "unknown" }, ok: false };
      }
      case "request_chat_input": {
        const reply = await port.dispatch<RequestInputReply>({ type: "RequestInput", field: call.args.field });
        if (reply?.status === "queued" || reply?.status === "alreadyPending") {
          this.#lastCardAt = this.#o.clock.now();
          return { result: { status: "sent" }, ok: true, ack: cardSentAck(call.args.field) };
        }
        return { result: { status: "refused", reason: reply?.status === "refused" ? reply.reason : "unknown" }, ok: false };
      }
      case "flag_for_review":
        await port.dispatch({ type: "FlagForReview", kind: call.args.kind, reason: call.args.reason });
        return { result: { status: "flagged" }, ok: true };
      case "opt_out": {
        if (!call.args.confirmed) return { result: { status: "confirmFirst", note: "ask the customer to confirm they want to stop" }, ok: false };
        this.#selfFinalized = true;
        const reply = await port.dispatch<{ status: string }>({ type: "OptOutByCall" });
        if (reply?.status === "optedOut") return { result: { status: "optedOut" }, ok: true, ack: OPTED_OUT_GOODBYE, endCall: true };
        // Refused (already submitted, say): the call goes on and the agent hears why (P5 review #17).
        this.#selfFinalized = false;
        return { result: { status: "refused", reason: (reply as { reason?: string } | undefined)?.reason ?? "unknown" }, ok: false };
      }
      case "end_call":
        return { result: { status: "ending" }, ok: true, endCall: true };
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Chat events (P5-T08)

  #onSessionUpdate(update: SessionUpdate): void {
    if (this.#stopping) return;
    for (const event of update.events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "field.candidate" && event.channel === "chat") {
        const candidate = payload.candidate as { field?: string; status?: string } | undefined;
        const field = candidate?.field;
        if (!field || !isRecordField(field)) continue;
        if (candidate.status === "invalid") this.#rejections.set(field, (this.#rejections.get(field) ?? 0) + 1);
        this.#note({ field, result: candidate.status === "valid" ? "accepted" : candidate.status === "skipped" ? "skipped" : "rejected" });
      } else if (event.type === "input.cancelled" && payload.reason === "too many attempts") {
        const request = payload.request as { field?: string } | undefined;
        if (request?.field) this.#note({ field: request.field, result: "cancelled" });
      } else if (event.type === "input.requested" || event.type === "input.resumed") {
        this.#lastCardAt = this.#o.clock.now();
      } else if (event.type === "session.finalized" && !this.#selfFinalized) {
        // Finalized from the chat (Stop → Yes, or Submit → Yes) during the call: say so and end (P4-T05 → P5-T09).
        const optedOut = payload.outcome === "optedOut";
        void this.#sayTemplated(optedOut ? OPTED_OUT_GOODBYE : SUBMITTED_GOODBYE).then(() =>
          this.#end(optedOut ? "opted_out" : "agent_ended", { code: CloseCode.NORMAL, reason: "agent ended" }),
        );
      }
    }
  }

  #note(note: ChatEventNote): void {
    // One note per field: the latest outcome is what the agent should mention.
    this.#pending = [...this.#pending.filter((n) => n.field !== note.field), note];
    this.#scheduleProactive();
  }

  #scheduleProactive(): void {
    if (this.#proactiveTimer !== null || this.#stopping) return;
    this.#proactiveTimer = this.#o.clock.setTimeout(() => {
      this.#proactiveTimer = null;
      if (this.#stopping || this.#pending.length === 0) return;
      // Not while anyone is speaking or a turn is in flight; the notes then ride along with the next turn.
      if (this.#turn || this.#userTurns.speaking) return;
      void this.#agentTurn({ proactive: true });
    }, this.#t.proactiveIdleMs);
  }

  #clearProactive(): void {
    if (this.#proactiveTimer !== null) this.#o.clock.clearTimeout(this.#proactiveTimer);
    this.#proactiveTimer = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Silence (P5-T10)

  #armSilence(): void {
    this.#clearSilence();
    if (this.#stopping) return;
    this.#silenceTimer = this.#o.clock.setTimeout(() => {
      this.#silenceTimer = null;
      void this.#onSilence();
    }, this.#t.silenceMs);
  }

  #clearSilence(): void {
    if (this.#silenceTimer !== null) this.#o.clock.clearTimeout(this.#silenceTimer);
    this.#silenceTimer = null;
  }

  async #onSilence(): Promise<void> {
    if (this.#stopping || this.#turn || this.#userTurns.speaking) return;
    if (this.#o.clock.now() - this.#lastCardAt < this.#t.cardSuspendMs) {
      this.#armSilence(); // they're probably looking for the serial number or typing
      return;
    }
    this.#reprompts += 1;
    if (this.#reprompts > this.#t.silenceReprompts) {
      await this.#end("silence", { code: CloseCode.NORMAL, reason: "silence" });
      return;
    }
    await this.#sayTemplated(REPROMPTS[Math.min(this.#reprompts, REPROMPTS.length) - 1] ?? "Are you still there?");
    this.#armSilence();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // TTS and the end

  #onTts(event: TtsEvent): void {
    if (event.type === "audio" || event.type === "flushed") {
      if (this.#turn?.id === event.turnId) this.#turn.speech.onTts(event);
      return;
    }
    if (event.type === "error" && !this.#stopping) {
      // The adapter already retried once. The words go to the chat instead, and the call ends (failure matrix).
      this.#o.log.error({ message: event.error.message }, "TTS failed; ending the call");
      // The current turn's words (it isn't in the history yet, P5 review #14).
      const text = this.#turn?.speech.text;
      if (text) this.#dispatchQuietly({ type: "AgentSays", text });
      void this.#end("provider_error", { code: CloseCode.NORMAL, reason: "call ended" });
    }
  }

  #dispatchQuietly(command: { type: string } & Record<string, unknown>): void {
    void this.#o.port.dispatch(command).catch((err) => this.#o.log.error({ command: command.type, message: (err as Error).message }, "call command failed"));
  }

  /** Ends the call exactly once: timers, speech, providers, the ledger, EndCall, then the socket. */
  #end(reason: CallEndReason, close: { code: number; reason: string } | null): Promise<void> {
    if (this.#ending) return this.#ending;
    this.#stopping = true;
    this.#ending = (async () => {
      this.#clearSilence();
      this.#clearProactive();
      if (this.#bargeTimer !== null) this.#o.clock.clearTimeout(this.#bargeTimer);
      for (const timer of this.#timers) this.#o.clock.clearTimeout(timer);
      this.#unsubscribe?.();
      const turn = this.#turn;
      if (turn?.speech.speaking && reason !== "agent_ended" && reason !== "opted_out") {
        turn.abort.abort();
        turn.speech.cancel();
      } else turn?.abort.abort();
      this.#userTurns.flush();
      // EndCall first (the chat takes over at once, P5-T09 ≤ 1 s), the providers' closes alongside (P5 review #10).
      const endCall = this.#o.port.dispatch({ type: "EndCall", callId: this.#o.callId, reason }).catch((err) => {
        this.#o.log.error({ message: (err as Error).message }, "EndCall failed");
      });
      await Promise.allSettled([endCall, this.#stt?.close(), this.#tts?.close()]);
      void this.#o.port.recordSttSeconds(Math.round((this.#sttBytes / MIC_BYTES_PER_SECOND) * 100) / 100);
      this.#o.log.info({ reason, seconds: Math.round((this.#o.clock.now() - this.#startedAt) / 1000), bargeIns: this.bargeIns }, "call ended");
      if (close) this.#o.close(close.code, close.reason);
      this.#resolveEnded();
    })();
    return this.#ending;
  }
}
