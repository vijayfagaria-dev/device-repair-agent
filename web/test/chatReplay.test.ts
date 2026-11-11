// P3-T06: the starter handles the replay on /chat. Replayed transcript lines, messages and cards render once (deduped by
// id, so a reconnect without a reload adds nothing), replayed answers show as user bubbles, sessionState becomes the
// header notice, and syncDone is accepted silently.
import { CallServerMessageType, ChatServerMessageType, InputKind, type InputRequest, Role } from "@device-repair/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { permanentCloseNotice, sessionNotice } from "../src/lib/sessionState";
import { ActionType, type Action } from "../src/state/actions";
import { initialState, ThreadItemKind, type ConversationState } from "../src/state/conversation";
import { conversationReducer } from "../src/state/reducer";
import type { Ui } from "../src/state/ui";

// socket.ts reads the page's session id at import; the routing under test doesn't need it.
vi.mock("../src/config", () => ({ sessionId: "00000000-0000-4000-8000-000000000000" }));
const { handleChatMessage, newReplayTracker } = await import("../src/transport/chatMessages");

const card: InputRequest = { type: ChatServerMessageType.INPUT_REQUEST, id: "req_email_1", field: "email", kind: InputKind.EMAIL, label: "Your email address", required: true };

let n = 0;
const key = () => `k${++n}`;
const apply = (state: ConversationState, ...actions: Action[]) => actions.reduce(conversationReducer, state);

/** The replay of a session that had a call, some chat, an answered card and one open card (protocol.md §4). */
const replay = (): Action[] => [
  { type: ActionType.ADD_TRANSCRIPT, msg: { id: "ta_c1_1", role: Role.AGENT, text: "Hi! What device is it?", final: true }, key: key(), time: "10:00" },
  { type: ActionType.ADD_TRANSCRIPT, msg: { id: "tu_c1_1", role: Role.USER, text: "An iPhone 14 Pro", final: true }, key: key(), time: "10:00" },
  { type: ActionType.ADD_MESSAGE, msg: { id: "m_a1", role: Role.AGENT, text: "What's your serial number?" }, key: key(), time: "10:01" },
  { type: ActionType.ADD_MESSAGE, msg: { id: "m_u1", role: Role.USER, text: "352099001761481", requestId: "req_serialNumber_1" }, key: key(), time: "10:01" },
  { type: ActionType.SHOW_CARD, spec: card, key: key() },
];

const shape = (state: ConversationState) =>
  state.items.map((item) => (item.kind === ThreadItemKind.TRANSCRIPT || item.kind === ThreadItemKind.MESSAGE ? [item.kind, item.role, item.text] : [item.kind]));

describe("replayed history in the reducer", () => {
  it("renders transcript lines, agent messages and replayed answers (as user bubbles) in order, then the open card", () => {
    const state = apply(initialState(), ...replay());
    expect(shape(state)).toEqual([
      [ThreadItemKind.TRANSCRIPT, Role.AGENT, "Hi! What device is it?"],
      [ThreadItemKind.TRANSCRIPT, Role.USER, "An iPhone 14 Pro"],
      [ThreadItemKind.MESSAGE, Role.AGENT, "What's your serial number?"],
      [ThreadItemKind.MESSAGE, Role.USER, "352099001761481"],
      [ThreadItemKind.PROMPT], // the open text-like card's prompt
    ]);
    expect(state.active?.id).toBe("req_email_1");
  });

  it("a second replay on reconnect (no reload) adds nothing: everything is deduped by id", () => {
    const once = apply(initialState(), ...replay());
    const twice = apply(once, ...replay());
    expect(shape(twice)).toEqual(shape(once));
    expect(twice.active?.id).toBe("req_email_1");
    expect(twice.queue).toEqual([]);
  });

  it("a replayed transcript line updates the same line shown live on /call, in place", () => {
    const live = apply(initialState(), { type: ActionType.ADD_TRANSCRIPT, msg: { id: "tu_c1_1", role: Role.USER, text: "An iPhone", final: false }, key: key(), time: "10:00" });
    const replayed = apply(live, { type: ActionType.ADD_TRANSCRIPT, msg: { id: "tu_c1_1", role: Role.USER, text: "An iPhone 14 Pro", final: true }, key: key(), time: "10:00" });
    expect(replayed.items).toHaveLength(1);
    expect(replayed.items[0]).toMatchObject({ text: "An iPhone 14 Pro", final: true });
  });

  it("skips a replayed answer to a card this page answered itself (its answer bubble already shows it)", () => {
    const answered = apply(
      initialState(),
      { type: ActionType.SHOW_CARD, spec: card, key: key() },
      { type: ActionType.SUBMIT_CARD, id: "req_email_1", answer: { value: "asha@example.com" }, key: key(), time: "10:02" },
    );
    const after = apply(answered, { type: ActionType.ADD_MESSAGE, msg: { id: "m_u2", role: Role.USER, text: "asha@example.com", requestId: "req_email_1" }, key: key(), time: "10:02" });
    expect(after.items.filter((item) => item.kind === ThreadItemKind.MESSAGE)).toEqual([]);
    expect(after.items.filter((item) => item.kind === ThreadItemKind.ANSWER)).toHaveLength(1);
  });
});

describe("cards after a reconnect without a reload (the page kept its state)", () => {
  const cardY: InputRequest = { ...card, id: "req_phone_2", field: "phone", kind: InputKind.PHONE, label: "Your phone number" };
  const sync = (open: string[]): Action => ({ type: ActionType.SYNC_CARDS, open, key: key() });

  it("cancels a card that closed while the page was offline, and opens the one the replay sent instead", () => {
    const before = apply(initialState(), { type: ActionType.SHOW_CARD, spec: card, key: key() });
    // While offline the server cancelled req_email_1 and opened req_phone_2; the replay sends only the open card.
    const after = apply(before, { type: ActionType.SHOW_CARD, spec: cardY, key: key() }, sync(["req_phone_2"]));
    expect(after.cards.req_email_1.status).toBe("cancelled");
    expect(after.active?.id).toBe("req_phone_2");
    expect(after.queue).toEqual([]);
  });

  it("reopens a card this page submitted when the server still has it open (the answer never landed, or was rejected)", () => {
    const submitted = apply(
      initialState(),
      { type: ActionType.SHOW_CARD, spec: card, key: key() },
      { type: ActionType.SUBMIT_CARD, id: "req_email_1", answer: { value: "asha@example" }, key: key(), time: "10:02" },
    );
    expect(submitted.active).toBeNull();
    const after = apply(submitted, { type: ActionType.SHOW_CARD, spec: card, key: key() }, sync(["req_email_1"]));
    expect(after.active?.id).toBe("req_email_1");
    expect(after.active?.error).toBeTruthy();
  });

  it("leaves cards alone when the replay agrees with the page (a plain reconnect changes nothing)", () => {
    const before = apply(initialState(), ...replay());
    const after = apply(before, ...replay(), sync(["req_email_1"]));
    expect(after.cards).toEqual(before.cards);
    expect(after.active?.id).toBe(before.active?.id);
    expect(shape(after)).toEqual(shape(before));
  });

  it("an answer given elsewhere (another tab, or this page before a reload) closes the card here and opens the next", () => {
    const before = apply(initialState(), { type: ActionType.SHOW_CARD, spec: card, key: key() }, { type: ActionType.SHOW_CARD, spec: cardY, key: key() });
    expect(before.active?.id).toBe("req_email_1");
    const after = apply(before, {
      type: ActionType.ADD_MESSAGE,
      msg: { id: "m_u3", role: Role.USER, text: "asha@example.com", requestId: "req_email_1" },
      key: key(),
      time: "10:03",
    });
    expect(after.cards.req_email_1.status).toBe("submitted");
    expect(after.active?.id).toBe("req_phone_2");
    // The answer bubble comes before the next card's prompt.
    const kinds = after.items.map((item) => item.kind);
    expect(kinds.lastIndexOf(ThreadItemKind.MESSAGE)).toBeLessThan(kinds.lastIndexOf(ThreadItemKind.PROMPT));
  });
});

describe("handleChatMessage routing", () => {
  const fakeUi = () => {
    const calls: [string, unknown][] = [];
    const record = (name: string) => (arg: unknown) => calls.push([name, arg]);
    const ui = {
      setCall: record("setCall"),
      setLevel: record("setLevel"),
      setNotice: record("setNotice"),
      addTranscript: record("addTranscript"),
      addMessage: record("addMessage"),
      addNote: record("addNote"),
      showInputCard: record("showInputCard"),
      rejectInputCard: record("rejectInputCard"),
      cancelInputCard: record("cancelInputCard"),
      showRecord: record("showRecord"),
      showSessionState: record("showSessionState"),
      syncCards: record("syncCards"),
    } as unknown as Ui;
    return { ui, calls };
  };

  it("routes the new /chat types: transcript, sessionState; accepts syncDone and unknown types silently", () => {
    const { ui, calls } = fakeUi();
    const transcript = { type: "transcript", id: "ta_c1_2", role: "agent", text: "Got it.", final: true };
    const state = { type: "sessionState", id: "state_3", status: "active", callActive: false, outcome: null, revision: null, voiceAvailable: true, notice: null };
    handleChatMessage(ui, JSON.stringify(transcript));
    handleChatMessage(ui, JSON.stringify(state));
    handleChatMessage(ui, JSON.stringify({ type: "syncDone", id: "sync_9", lastSeq: 9 }));
    handleChatMessage(ui, JSON.stringify({ type: "somethingFromTheFuture" }));
    handleChatMessage(ui, "not json");
    expect(calls).toEqual([
      ["addTranscript", transcript],
      ["showSessionState", state],
    ]);
    // Same type string as the call transcript, so the reducer treats both alike.
    expect(ChatServerMessageType.TRANSCRIPT).toBe(CallServerMessageType.TRANSCRIPT);
  });
});

describe("replay tracking per connection", () => {
  it("at syncDone, reports which cards the replay sent; cards after it are live, not part of the replay", () => {
    const calls: [string, unknown][] = [];
    const ui = { showInputCard: () => {}, syncCards: (open: string[]) => calls.push(["syncCards", open]) } as unknown as Ui;
    const tracker = newReplayTracker();
    handleChatMessage(ui, JSON.stringify(card), tracker);
    handleChatMessage(ui, JSON.stringify({ type: "syncDone", id: "sync_4", lastSeq: 4 }), tracker);
    handleChatMessage(ui, JSON.stringify({ ...card, id: "req_phone_2" }), tracker); // live
    expect(calls).toEqual([["syncCards", ["req_email_1"]]]);
  });
});

describe("notices", () => {
  it("shows the server's notice first, then closed or voice-unavailable; nothing for a normal session", () => {
    expect(sessionNotice({ status: "active", notice: "The call was interrupted; let's continue here.", voiceAvailable: true })).toBe(
      "The call was interrupted; let's continue here.",
    );
    expect(sessionNotice({ status: "closed", notice: null, voiceAvailable: true })).toMatch(/closed/);
    expect(sessionNotice({ status: "active", notice: null, voiceAvailable: false })).toMatch(/continue here in chat/);
    expect(sessionNotice({ status: "finalized", notice: null, voiceAvailable: true })).toBeNull();
  });

  it("treats only 4400 and 4403 as permanent (no reconnect); 4429, 1011 and 1012 keep retrying", () => {
    expect(permanentCloseNotice(4400)).toMatch(/isn't valid/);
    expect(permanentCloseNotice(4403)).toMatch(/isn't allowed/);
    for (const code of [1000, 1006, 1011, 1012, 4429]) expect(permanentCloseNotice(code), String(code)).toBeNull();
  });
});
