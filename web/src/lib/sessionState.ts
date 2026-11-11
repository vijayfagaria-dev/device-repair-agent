import type { SessionStateMessage } from "@device-repair/shared/protocol";

/**
 * The header notice for a `sessionState` (protocol.md §3.3): the server's own notice first ("The call was
 * interrupted; let's continue here."), then what the state itself means for the user. No notice otherwise.
 */
export function sessionNotice(state: Pick<SessionStateMessage, "status" | "notice" | "voiceAvailable">): string | null {
  if (state.notice) return state.notice;
  if (state.status === "closed") return "This claim is closed and can't be changed. Open the page without a session link to start a new one.";
  if (!state.voiceAvailable) return "Voice is busy right now. You can continue here in chat.";
  return null;
}

/** Close codes after which reconnecting can't help (protocol.md §6): stop retrying and say why. */
export function permanentCloseNotice(code: number): string | null {
  switch (code) {
    case 4400:
      return "This session link isn't valid. Open the page without a session link to start a new claim.";
    case 4403:
      return "This page isn't allowed to connect to the chat server.";
    default:
      return null;
  }
}
