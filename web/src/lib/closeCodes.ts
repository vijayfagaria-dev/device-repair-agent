// Friendly text for the server's close codes (protocol.md §6, P4-T06). The server completes every upgrade and then
// closes with a code, so the page can say why instead of a bare "call ended".

/** What the thread says when the call socket closes with this code; null for an ordinary end ("Call ended: …"). */
export function callCloseMessage(code: number): string | null {
  switch (code) {
    case 4429:
      return "Voice is busy right now. You can continue here in chat.";
    case 4403:
      return "This page isn't allowed to connect to the voice server.";
    case 4409:
      return "A call is already active in another tab.";
    case 4410:
      return "This claim is closed. Open the page without a session link to start a new one.";
    case 4411:
      return "You stopped this claim earlier. Confirm in the chat that you want to resume it, then call again.";
    case 4400:
      return "This session link isn't valid. Open the page without a session link to start a new claim.";
    default:
      return null;
  }
}

/** The header notice while the chat socket retries; 4429 means too many new claims from this network (temporary). */
export function chatRetryNotice(code: number, url: string, retrySeconds: number): string {
  if (code === 4429) return `Too many new claims were started from your network. Retrying in ${retrySeconds}s…`;
  return `Can't reach the chat server at ${url}. Retrying in ${retrySeconds}s…`;
}

/** The page's own link, to open the same claim on another device (the session id is in the URL). */
export const sessionLink = (href: string): string => href.split("#", 1)[0] ?? href;
