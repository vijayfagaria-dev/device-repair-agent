import { ChatServerMessageType, type ChatServerMessage } from "@device-repair/shared/protocol";
import type { Ui } from "../state/ui";
import { parseMessage } from "./socket";

/** What one /chat connection's replay has sent so far (protocol.md §4): the cards, until syncDone. */
export interface ReplayTracker {
  syncing: boolean;
  cards: string[];
}

/** A fresh tracker for each new socket: every connection starts with a replay. */
export const newReplayTracker = (): ReplayTracker => ({ syncing: true, cards: [] });

export function handleChatMessage(ui: Ui, data: unknown, replay?: ReplayTracker): void {
  const msg = parseMessage<ChatServerMessage>(data);
  switch (msg?.type) {
    case ChatServerMessageType.MESSAGE:
      ui.addMessage(msg);
      break;
    case ChatServerMessageType.INPUT_REQUEST:
      if (replay?.syncing) replay.cards.push(msg.id);
      // The server sends a card when it is the session's one open card, so it takes the place of whatever is shown.
      ui.showInputCard(msg, { preempt: true });
      break;
    case ChatServerMessageType.INPUT_ERROR:
      ui.rejectInputCard(msg.requestId, msg.message);
      break;
    case ChatServerMessageType.INPUT_CANCEL:
      ui.cancelInputCard(msg.requestId, msg.reason);
      break;
    case ChatServerMessageType.RECORD:
      ui.showRecord(msg.record);
      break;
    // protocol.md §3.3 / §4: replayed call transcript lines (same ids as on /call, so on-screen lines update in place),
    // the session's state, and the end of the replay.
    case ChatServerMessageType.TRANSCRIPT:
      ui.addTranscript(msg);
      break;
    case ChatServerMessageType.SESSION_STATE:
      ui.showSessionState(msg);
      break;
    case ChatServerMessageType.SYNC_DONE:
      // The page's cards catch up with the server's (a reconnect without a reload may have missed cancels).
      if (replay?.syncing) {
        replay.syncing = false;
        ui.syncCards(replay.cards);
      }
      break;
    case undefined:
      break;
    default:
      // Unknown types are ignored at runtime; this makes the compiler flag a known type left unhandled.
      msg satisfies never;
  }
}
