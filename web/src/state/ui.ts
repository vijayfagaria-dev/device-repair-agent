import type { ChatMessage, FinalRecord, InputRequest, InputValue, SessionStateMessage, TranscriptMessage } from "@voice-chat-agent/shared/protocol";
import type { CallState } from "./conversation";

export interface Ui {
  setCall(state: CallState, text: string): void;
  setLevel(level: number): void;
  setNotice(text: string | null): void;
  addTranscript(msg: Omit<TranscriptMessage, "type">): void;
  addMessage(msg: Omit<ChatMessage, "type">): void;
  addNote(text: string): void;
  /** `preempt`: the server's open card replaces the one shown now (see ActionType.SHOW_CARD). */
  showInputCard(spec: InputRequest, options?: { preempt?: boolean }): void;
  rejectInputCard(id: string, message?: string): void;
  cancelInputCard(id: string, reason?: string): void;
  showRecord(record: FinalRecord): void;
  showSessionState(state: Omit<SessionStateMessage, "type">): void;
  /** The replay ended (syncDone); `open` lists the cards it sent (protocol.md §4). */
  syncCards(open: string[]): void;
}

/** Sends an answer to the agent; throw to reopen the card with the error message. */
export type SendInput = (spec: InputRequest, value: InputValue, files: File[]) => Promise<void>;

export interface CallControls {
  start(): void;
  hangUp(): void;
}
