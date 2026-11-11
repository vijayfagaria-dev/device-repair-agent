// OptOutRequested (P4-T05, PD6): the chat header's Stop button. It finalizes nothing on its own: it pauses the open
// card (back to `queued`, so the planner can bring it back) and opens "Stop your claim?" in its place (protocol.md §5:
// it takes priority over the open card). Yes → optedOut (SubmitChatInput, finalize); No → the paused card returns.
// An active call is told through the committed events; saying goodbye and ending it is the call engine's (P5-T09).
import { nextRequestId, openCardDrafts } from "../../agent/chatPlanner.js";
import { ControlField, optOutCard } from "../../agent/chatTemplates.js";
import type { EventDraft, Handler } from "../commands.js";
import type { OpenCardRef, OptOutRequested } from "./chatInput.js";
import { openCardRef } from "./submitChatInput.js";

/** `alreadyAsked` carries the open card, which the socket sends again (the page may have lost track of it). */
export type OptOutReply = { status: "asked"; requestId: string } | { status: "alreadyAsked"; requestId: string; open?: OpenCardRef } | { status: "notActive" };

export const optOutHandler: Handler<OptOutRequested, OptOutReply> = (snapshot) => {
  if (snapshot.session.status !== "active") return { reply: { status: "notActive" } };
  const pending = snapshot.requests.find((r) => r.field === ControlField.OPT_OUT && (r.status === "open" || r.status === "queued"));
  if (pending) {
    // A second tap: nothing new, but the page gets the open card again in case it isn't showing it.
    const open = openCardRef(snapshot);
    return { reply: open ? { status: "alreadyAsked", requestId: pending.id, open } : { status: "alreadyAsked", requestId: pending.id } };
  }

  const events: EventDraft[] = [{ type: "optout.requested", channel: "chat", payload: { callActive: snapshot.session.activeCallId !== null } }];
  const open = snapshot.requests.find((r) => r.status === "open");
  if (open) {
    // Paused before the confirm card opens: at most one card is open (input_requests_one_open_idx).
    events.push({ type: "input.paused", channel: "chat", payload: { requestId: open.id }, inputRequestUpdate: { id: open.id, status: "queued" } });
  }
  const requestId = nextRequestId(snapshot, ControlField.OPT_OUT);
  events.push(...openCardDrafts(requestId, ControlField.OPT_OUT, optOutCard(), null));
  return { events, activity: true, reply: { status: "asked", requestId } };
};
