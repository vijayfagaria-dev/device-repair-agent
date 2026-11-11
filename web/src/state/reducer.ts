import { isChoiceKind } from "../lib/inputs";
import { Role } from "@device-repair/shared/protocol";
import { ActionType, type Action, type ActionOf } from "./actions";
import { CallState, CardStatus, ThreadItemKind, type ConversationState, type ThreadItem } from "./conversation";

const DEFAULT_REJECT_MESSAGE = "Please check this value and try again.";
/** A card this page answered that is still open after a reconnect: the answer didn't land (or wasn't accepted). */
const RESEND_MESSAGE = "We didn't get this answer. Please check it and send it again.";

export function conversationReducer(state: ConversationState, action: Action): ConversationState {
  switch (action.type) {
    case ActionType.SET_CALL:
      return setCall(state, action);
    case ActionType.SET_NOTICE:
      return { ...state, notice: action.text };
    case ActionType.ADD_NOTE:
      return addNote(state, action);
    case ActionType.ADD_TRANSCRIPT:
      return addTranscript(state, action);
    case ActionType.ADD_MESSAGE:
      return addMessage(state, action);
    case ActionType.SHOW_RECORD:
      return showRecord(state, action);
    case ActionType.SHOW_CARD:
      return showCard(state, action);
    case ActionType.REJECT_CARD:
      return rejectCard(state, action);
    case ActionType.CANCEL_CARD:
      return cancelCard(state, action);
    case ActionType.SUBMIT_CARD:
      return submitCard(state, action);
    case ActionType.ACK_ANSWER:
      return ackAnswer(state, action);
    case ActionType.SYNC_CARDS:
      return syncCards(state, action);
    case ActionType.SET_SESSION:
      return state.sessionStatus === action.status ? state : { ...state, sessionStatus: action.status };
  }
}

const toRole = (role: string): Role => (role === Role.USER ? Role.USER : Role.AGENT);

function setCall(state: ConversationState, { state: callState, text, now }: ActionOf<ActionType.SET_CALL>): ConversationState {
  const connectedAt = callState === CallState.CONNECTED ? now : null;
  return { ...state, call: { ...state.call, state: callState, text, connectedAt } };
}

function addNote(state: ConversationState, { text, key }: ActionOf<ActionType.ADD_NOTE>): ConversationState {
  return { ...state, items: [...state.items, { kind: ThreadItemKind.NOTE, key, text }] };
}

function addTranscript(state: ConversationState, { msg, key, time }: ActionOf<ActionType.ADD_TRANSCRIPT>): ConversationState {
  const { role, final, id } = msg;
  const text = msg.text || "";
  const lineKey = id ? `id:${id}` : `role:${role}`;
  const items = [...state.items];
  const transcripts = { ...state.transcripts };
  const index = items.findIndex((item) => item.key === transcripts[lineKey]);
  const existing = index >= 0 ? items[index] : undefined;
  if (existing?.kind === ThreadItemKind.TRANSCRIPT) {
    items[index] = { ...existing, text, final };
  } else {
    items.push({ kind: ThreadItemKind.TRANSCRIPT, key, role: toRole(role), text, final, time });
  }
  if (final && !id) delete transcripts[lineKey];
  else transcripts[lineKey] = existing?.key ?? key;
  return { ...state, items, transcripts };
}

function addMessage(state: ConversationState, { msg, key, time }: ActionOf<ActionType.ADD_MESSAGE>): ConversationState {
  const { id, role } = msg;
  if (id && state.items.some((item) => item.kind === ThreadItemKind.MESSAGE && item.id === id)) return state;
  const message: ThreadItem = { kind: ThreadItemKind.MESSAGE, key, id, role: toRole(role), text: msg.text || "", time };
  const answered = role === Role.USER && msg.requestId ? state.cards[msg.requestId] : undefined;
  // A replayed answer (reconnect without a reload) to a card this page answered itself: its own answer bubble already
  // shows it (protocol.md v1.2 `requestId`).
  if (answered?.status === CardStatus.SUBMITTED) return state;
  // An answer given elsewhere (another tab, or this page before it lost its socket) to a card still open or queued
  // here: the card is done; show the answer, then move on to the next card.
  if (msg.requestId && (answered?.status === CardStatus.OPEN || answered?.status === CardStatus.QUEUED)) {
    const s = draft(state);
    s.queue = s.queue.filter((queuedId) => queuedId !== msg.requestId);
    s.cards[msg.requestId] = { ...answered, status: CardStatus.SUBMITTED };
    if (s.active?.id === msg.requestId) s.active = null;
    s.items.push(message);
    openNextOnDraft(s, `${key}:next`);
    return s;
  }
  return { ...state, items: [...state.items, message] };
}

function showRecord(state: ConversationState, { record, key }: ActionOf<ActionType.SHOW_RECORD>): ConversationState {
  const index = state.items.findIndex((item) => item.kind === ThreadItemKind.RECORD);
  const items = [...state.items];
  if (index >= 0) items[index] = { kind: ThreadItemKind.RECORD, key: items[index].key, record };
  else items.push({ kind: ThreadItemKind.RECORD, key, record });
  return { ...state, items };
}

function ackAnswer(state: ConversationState, { key }: ActionOf<ActionType.ACK_ANSWER>): ConversationState {
  const index = state.items.findIndex((item) => item.key === key);
  const item = index >= 0 ? state.items[index] : undefined;
  if (item?.kind !== ThreadItemKind.ANSWER) return state;
  const items = [...state.items];
  items[index] = { ...item, acked: true };
  return { ...state, items };
}

type Draft = ConversationState;

function draft(state: ConversationState): Draft {
  return { ...state, items: [...state.items], cards: { ...state.cards }, queue: [...state.queue] };
}

function openOnDraft(s: Draft, id: string, error: string | null, key: string): void {
  const entry = s.cards[id];
  if (entry.answerKey) s.items = s.items.filter((item) => item.key !== entry.answerKey);
  let { promptKey } = entry;
  if (!isChoiceKind(entry.spec.kind) && !promptKey) {
    promptKey = `${key}:prompt`;
    s.items.push({ kind: ThreadItemKind.PROMPT, key: promptKey, spec: entry.spec });
  }
  s.cards[id] = { ...entry, status: CardStatus.OPEN, answerKey: undefined, promptKey };
  s.active = { id, key: `${key}:card`, error };
}

function openNextOnDraft(s: Draft, key: string): void {
  const next = s.active ? undefined : s.queue.shift();
  if (next) openOnDraft(s, next, null, key);
}

/** The shown card steps aside for a server card (not queued: only the server brings it back, or cancels it). */
function pauseActiveOnDraft(s: Draft): void {
  if (!s.active) return;
  const { id } = s.active;
  const entry = s.cards[id];
  if (entry.promptKey) s.items = s.items.filter((item) => item.key !== entry.promptKey);
  s.cards[id] = { ...entry, status: CardStatus.PAUSED, promptKey: undefined };
  s.active = null;
}

function requeueActiveOnDraft(s: Draft): void {
  if (!s.active) return;
  const { id } = s.active;
  const entry = s.cards[id];
  if (entry.promptKey) s.items = s.items.filter((item) => item.key !== entry.promptKey);
  s.cards[id] = { ...entry, status: CardStatus.QUEUED, promptKey: undefined };
  s.queue.unshift(id);
  s.active = null;
}

function showCard(state: ConversationState, { spec, key, preempt }: ActionOf<ActionType.SHOW_CARD>): ConversationState {
  if (!spec.id) return state;
  const known = state.cards[spec.id];
  if (!preempt) {
    if (known) return state;
    const s = draft(state);
    s.cards[spec.id] = { spec, status: CardStatus.QUEUED };
    s.queue.push(spec.id);
    openNextOnDraft(s, key);
    return s;
  }
  // The server's open card. Already open here, or answered here (syncCards sorts that out at syncDone): nothing to do.
  if (known && (known.status === CardStatus.OPEN || known.status === CardStatus.SUBMITTED)) return state;
  const s = draft(state);
  pauseActiveOnDraft(s);
  s.queue = s.queue.filter((queuedId) => queuedId !== spec.id);
  s.cards[spec.id] = { ...known, spec, status: CardStatus.QUEUED };
  openOnDraft(s, spec.id, null, key);
  return s;
}

function rejectCard(state: ConversationState, { id, message, key }: ActionOf<ActionType.REJECT_CARD>): ConversationState {
  const status = state.cards[id]?.status;
  if (status !== CardStatus.OPEN && status !== CardStatus.SUBMITTED) return state;
  const s = draft(state);
  if (s.active?.id === id) s.active = null;
  else requeueActiveOnDraft(s);
  openOnDraft(s, id, message || DEFAULT_REJECT_MESSAGE, key);
  return s;
}

function cancelCard(state: ConversationState, { id, reason, key }: ActionOf<ActionType.CANCEL_CARD>): ConversationState {
  const entry = state.cards[id];
  if (!entry) return state;
  if (entry.status === CardStatus.QUEUED || entry.status === CardStatus.SUBMITTED || entry.status === CardStatus.PAUSED) {
    const s = draft(state);
    s.queue = s.queue.filter((queuedId) => queuedId !== id);
    s.cards[id] = { ...entry, status: CardStatus.CANCELLED };
    return s;
  }
  if (state.active?.id !== id) return state;
  const s = draft(state);
  s.cards[id] = { ...entry, status: CardStatus.CANCELLED };
  s.active = null;
  const suffix = reason ? ` (${reason})` : "";
  s.items.push({ kind: ThreadItemKind.NOTE, key, text: `${entry.spec.label}: no longer needed${suffix}` });
  openNextOnDraft(s, `${key}:next`);
  return s;
}

/**
 * The end of a replay (syncDone) after a reconnect without a reload: the page's cards catch up with the server's.
 * The replay sends exactly the open card (protocol.md §4), so a card open or queued here that it didn't send was
 * answered or cancelled while the page was offline (its cancel isn't replayed), and a card this page submitted that
 * the server still has open never got its answer accepted: it reopens.
 */
function syncCards(state: ConversationState, { open, key }: ActionOf<ActionType.SYNC_CARDS>): ConversationState {
  let next = state;
  for (const [id, entry] of Object.entries(state.cards)) {
    const stillOpen = open.includes(id);
    if (!stillOpen && (entry.status === CardStatus.OPEN || entry.status === CardStatus.QUEUED)) next = cancelCard(next, { type: ActionType.CANCEL_CARD, id, key: `${key}:${id}` });
    else if (stillOpen && entry.status === CardStatus.SUBMITTED) next = rejectCard(next, { type: ActionType.REJECT_CARD, id, message: RESEND_MESSAGE, key: `${key}:${id}` });
  }
  return next;
}

function submitCard(state: ConversationState, { id, answer, key, time }: ActionOf<ActionType.SUBMIT_CARD>): ConversationState {
  if (state.active?.id !== id) return state;
  const s = draft(state);
  const entry = s.cards[id];
  s.cards[id] = { ...entry, status: CardStatus.SUBMITTED, last: answer, answerKey: key };
  s.items.push({ kind: ThreadItemKind.ANSWER, key, spec: entry.spec, answer, acked: false, time });
  s.active = null;
  openNextOnDraft(s, `${key}:next`);
  return s;
}
