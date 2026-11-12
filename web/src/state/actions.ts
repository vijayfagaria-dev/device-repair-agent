import type { ChatMessage, FinalRecord, InputRequest, SessionStatus, TranscriptMessage } from "@voice-chat-agent/shared/protocol";
import type { Answer, CallState } from "./conversation";

export enum ActionType {
  SET_CALL = "setCall",
  SET_NOTICE = "setNotice",
  ADD_NOTE = "addNote",
  ADD_TRANSCRIPT = "addTranscript",
  ADD_MESSAGE = "addMessage",
  SHOW_RECORD = "showRecord",
  SHOW_CARD = "showCard",
  REJECT_CARD = "rejectCard",
  CANCEL_CARD = "cancelCard",
  SUBMIT_CARD = "submitCard",
  ACK_ANSWER = "ackAnswer",
  SYNC_CARDS = "syncCards",
  SET_SESSION = "setSession",
}

export type Action =
  | { type: ActionType.SET_CALL; state: CallState; text: string; now: number }
  | { type: ActionType.SET_NOTICE; text: string | null }
  | { type: ActionType.ADD_NOTE; text: string; key: string }
  | { type: ActionType.ADD_TRANSCRIPT; msg: Omit<TranscriptMessage, "type">; key: string; time: string }
  | { type: ActionType.ADD_MESSAGE; msg: Omit<ChatMessage, "type">; key: string; time: string }
  | { type: ActionType.SHOW_RECORD; record: FinalRecord; key: string }
  /**
   * `preempt`: the server's card (protocol.md §3.3: the server sends a card when it is THE open one). It replaces the
   * card shown now, which is paused until the server resumes or cancels it (the Stop flow, P4-T05), and a known card
   * the page had paused, queued or closed opens again. Without it (the demo), cards queue behind the open one.
   */
  | { type: ActionType.SHOW_CARD; spec: InputRequest; key: string; preempt?: boolean }
  | { type: ActionType.REJECT_CARD; id: string; message?: string; key: string }
  | { type: ActionType.CANCEL_CARD; id: string; reason?: string; key: string }
  | { type: ActionType.SUBMIT_CARD; id: string; answer: Answer; key: string; time: string }
  | { type: ActionType.ACK_ANSWER; key: string }
  /** End of a /chat replay (syncDone): `open` holds the cards the replay sent, i.e. the ones open on the server. */
  | { type: ActionType.SYNC_CARDS; open: string[]; key: string }
  /** The session's lifecycle from sessionState (the Stop button is offered only while it is active). */
  | { type: ActionType.SET_SESSION; status: SessionStatus };

export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;
