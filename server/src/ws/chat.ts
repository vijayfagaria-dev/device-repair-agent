// WS /chat (P3-T04; protocol.md §3.3–§4, §7).
//
// Per connection: handshake (Origin, session id, lazy creation; handshake.ts) → subscribe to the hub and buffer →
// replay from the database (history, open card, latest record, sessionState, syncDone) → flush the buffer (events
// after the replay's lastSeq, minus anything already sent) → live stream. Then the post-commit reactions run once
// (the planner's reconcile, P4-T01). A connect is not user activity: it moves no timer and reopens nothing; the only
// thing it can write is a card the planner finds missing (protocol.md §4 step 5).
//
// Inbound messages are validated with zod (shared/protocol/schemas.ts) and dispatched as commands; anything invalid
// or unknown is logged and dropped, and the socket stays open.
import { ChatClientMessageType, type ChatServerMessage, CloseCode, CloseReason, type SessionStateMessage } from "@device-repair/shared/protocol";
import { ChatClientMessageSchema, type ParsedChatClientMessage } from "@device-repair/shared/protocol/schemas";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { type CommandProcessor, UnsupportedCommandError } from "../session/commands.js";
import { STALE_REQUEST_MESSAGE, type SubmitChatInput, type SubmitChatInputReply } from "../session/handlers/chatInput.js";
import type { SessionHub, SessionUpdate } from "../session/hub.js";
import type { OptOutReply } from "../session/handlers/optOut.js";
import { inputErrorWire, inputRequestWire, sameSessionState, sessionStateWire, syncDoneWire, toChatMessages } from "./chatProjection.js";
import { loadReplay } from "./chatReplay.js";
import { acceptSessionSocket, type SocketDeps } from "./handshake.js";
import { closeWithNotice } from "./closing.js";

export interface ChatSocketDeps extends SocketDeps {
  hub: SessionHub;
  processor: CommandProcessor;
  /** `sessionState.voiceAvailable`: false while the quota guard would refuse a call (P10-T03). Default: true. */
  voiceAvailable?: () => boolean;
}

/**
 * A client that stops reading while messages pile up is dropped rather than buffered without bound; it reconnects
 * and replays, which is the recovery path anyway.
 */
export const MAX_CHAT_BUFFERED_BYTES = 1024 * 1024;
/** protocol.md §7: clientMetric at most once per second per socket. */
const CLIENT_METRIC_INTERVAL_MS = 1000;
/**
 * Answers and Stop taps per socket per window (P4-T02; the P3 audit's deferred inbound limit). A person answers a
 * card every few seconds at most; beyond this a client is looping, and each answer is a database transaction.
 */
export const MAX_COMMANDS_PER_WINDOW = 20;
const COMMAND_WINDOW_MS = 10_000;
export const TOO_FAST_MESSAGE = "You're sending answers too quickly. Please wait a moment and try again.";

export async function chatSocketRoutes(app: FastifyInstance, deps: ChatSocketDeps): Promise<void> {
  app.route({
    method: "GET",
    url: "/chat",
    // A plain HTTP GET (no upgrade) gets the same JSON 404 as any other unknown server path.
    handler: (_request, reply) => reply.callNotFound(),
    wsHandler: async (socket, request) => {
      const accepted = await acceptSessionSocket(socket, request, deps, "chat");
      if (!accepted) return;
      const connection = new ChatConnection(socket, accepted.session.id, accepted.log, deps);
      await connection.start();
      if (socket.readyState === socket.OPEN) accepted.onMessage((data, isBinary) => connection.receive(data.toString(), isBinary));
    },
  });
}

class ChatConnection {
  readonly #socket: WebSocket;
  readonly #sessionId: string;
  readonly #log: FastifyBaseLogger;
  readonly #deps: ChatSocketDeps;
  /** Ids of the messages sent on this socket: replay and buffered live updates may overlap. */
  readonly #sent = new Set<string>();
  readonly #buffer: SessionUpdate[] = [];
  #live = false;
  #lastSeq = 0;
  #state: SessionStateMessage | null = null;
  #lastMetricAt = 0;
  #windowStart = 0;
  #windowCount = 0;

  constructor(socket: WebSocket, sessionId: string, log: FastifyBaseLogger, deps: ChatSocketDeps) {
    this.#socket = socket;
    this.#sessionId = sessionId;
    this.#log = log;
    this.#deps = deps;
  }

  async start(): Promise<void> {
    // Subscribe first, so nothing committed while the replay is read is lost (protocol.md §4 step 2).
    const unsubscribe = this.#deps.hub.subscribe(this.#sessionId, (update) => {
      if (this.#live) this.#deliver(update);
      else this.#buffer.push(update);
    });
    this.#socket.once("close", unsubscribe);

    let replay: Awaited<ReturnType<typeof loadReplay>>;
    try {
      replay = await loadReplay(this.#deps.pool, this.#sessionId);
    } catch (err) {
      this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "chat replay failed");
      closeWithNotice(this.#socket, CloseCode.SERVER_ERROR, CloseReason.SERVER_ERROR);
      return;
    }
    if (this.#socket.readyState !== this.#socket.OPEN) return;

    this.#lastSeq = replay.lastSeq;
    for (const message of replay.history) this.#sendOnce(message);
    if (replay.openRequest) this.#sendOnce(replay.openRequest);
    if (replay.record) this.#sendOnce(replay.record);
    this.#sendState(replay.state);
    this.#send(syncDoneWire(replay.lastSeq));

    this.#live = true;
    for (const update of this.#buffer.splice(0)) this.#deliver(update);
    this.#log.debug({ lastSeq: replay.lastSeq, sent: this.#sent.size }, "chat replay sent");

    // Step 5: make the session's chat state what it should be (the planner, P4-T01). Never fails the connection.
    void this.#deps.processor.react(this.#sessionId);
  }

  /** One live (or buffered) committed update: its chat-visible events newer than the replay, then the state. */
  #deliver(update: SessionUpdate): void {
    for (const event of update.events) {
      if (event.seq <= this.#lastSeq) continue; // already in the replay
      // A card brought back after the Stop flow paused it (P4-T05) reuses its id: this socket may have sent it
      // before, and must send it again (the event itself is new, so the seq filter above already deduplicates it).
      const again = event.type === "input.resumed";
      // session.finalized carries its record (P6-T01): it lands after the cards the finalization closed and before
      // the closing message, which is a later event.
      for (const message of toChatMessages(event, update.record)) this.#sendOnce(message, again);
    }
    this.#sendState(sessionStateWire(update.session));
  }

  /** True while this socket is within its command budget (fixed window). */
  #withinBudget(): boolean {
    const now = Date.now();
    if (now - this.#windowStart >= COMMAND_WINDOW_MS) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    this.#windowCount += 1;
    return this.#windowCount <= MAX_COMMANDS_PER_WINDOW;
  }

  /** Sends sessionState when something the client sees changed, and never an older one after a newer one. */
  #sendState(projected: SessionStateMessage): void {
    const state = { ...projected, voiceAvailable: this.#deps.voiceAvailable?.() ?? projected.voiceAvailable };
    const previous = this.#state;
    if (previous && (versionOf(state) <= versionOf(previous) || sameSessionState(previous, state))) return;
    this.#state = state;
    this.#send(state);
  }

  #sendOnce(message: ChatServerMessage & { id?: string }, again = false): void {
    if (message.id !== undefined) {
      if (this.#sent.has(message.id) && !again) return;
      this.#sent.add(message.id);
    }
    this.#send(message);
  }

  #send(message: ChatServerMessage): void {
    const socket = this.#socket;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_CHAT_BUFFERED_BYTES) {
      this.#log.warn({ bufferedAmount: socket.bufferedAmount }, "chat client not reading; dropping the connection");
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message));
  }

  receive(text: string, isBinary: boolean): void {
    if (isBinary) {
      this.#log.debug("chat message dropped: binary");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.#log.debug("chat message dropped: not JSON");
      return;
    }
    const parsed = ChatClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const type = (json as { type?: unknown } | null)?.type;
      // The type (truncated) and issue paths only, never the values.
      this.#log.info(
        { type: typeof type === "string" ? type.slice(0, 40) : null, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
        "chat message dropped: invalid or unknown",
      );
      return;
    }
    void this.#handle(parsed.data);
  }

  async #handle(message: ParsedChatClientMessage): Promise<void> {
    switch (message.type) {
      case ChatClientMessageType.INPUT_RESPONSE:
        if (!this.#withinBudget()) {
          this.#log.warn("chat answer refused: too many commands on this socket");
          this.#send(inputErrorWire(message.requestId, 0, TOO_FAST_MESSAGE));
          return;
        }
        return this.#submit({ type: "SubmitChatInput", requestId: message.requestId, field: message.field, value: message.value });
      case ChatClientMessageType.OPT_OUT:
        if (!this.#withinBudget()) {
          this.#log.warn("optOut dropped: too many commands on this socket");
          return;
        }
        try {
          const { reply } = await this.#deps.processor.dispatch<OptOutReply>(this.#sessionId, { type: "OptOutRequested" });
          if (reply?.status === "alreadyAsked" && reply.open) this.#send(inputRequestWire(reply.open));
        } catch (err) {
          this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "optOut failed");
        }
        return;
      case ChatClientMessageType.CLIENT_METRIC: {
        const now = Date.now();
        if (now - this.#lastMetricAt < CLIENT_METRIC_INTERVAL_MS) return; // excess dropped (protocol.md §7)
        this.#lastMetricAt = now;
        this.#log.debug({ turnId: message.turnId, ms: message.ms }, "client metric received (stored from P11-T02)");
        return;
      }
    }
  }

  async #submit(command: SubmitChatInput): Promise<void> {
    let reply: SubmitChatInputReply | undefined;
    try {
      reply = (await this.#deps.processor.dispatch<SubmitChatInputReply>(this.#sessionId, command)).reply;
    } catch (err) {
      if (err instanceof UnsupportedCommandError) {
        reply = { status: "stale", message: STALE_REQUEST_MESSAGE };
      } else {
        // Code and message only: a database error's detail can quote the row (the user's answer).
        this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message, requestId: command.requestId }, "chat input failed");
        this.#send(inputErrorWire(command.requestId, 0, ANSWER_NOT_SAVED_MESSAGE));
        return;
      }
    }
    // Accepted and rejected answers reach the client through their committed events; only a stale one is answered here,
    // followed by the card that IS open, so a page showing the stale card switches to it (P4 review #1).
    if (reply?.status === "stale") {
      this.#send(inputErrorWire(command.requestId, 0, reply.message));
      if (reply.open) {
        this.#sent.add(reply.open.id);
        this.#send(inputRequestWire(reply.open));
      }
    }
  }
}

const versionOf = (state: SessionStateMessage) => Number(state.id.slice("state_".length));
export const ANSWER_NOT_SAVED_MESSAGE = "Your answer couldn't be saved. Please try again.";
