// P4-T05/T06 on the page: a server card pre-empts the one shown (the Stop flow) and the paused card comes back when
// the server resumes it; the session's status gates the Stop button; close codes and upload errors read as plain
// sentences; the copy-link button copies the page's own session link.
import { ChatServerMessageType, InputKind, type InputRequest } from "@device-repair/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callCloseMessage, chatRetryNotice, sessionLink } from "../src/lib/closeCodes";
import { ActionType, type Action } from "../src/state/actions";
import { CardStatus, initialState, selectOpenCard, ThreadItemKind, type ConversationState } from "../src/state/conversation";
import { conversationReducer } from "../src/state/reducer";
import type { Ui } from "../src/state/ui";

vi.mock("../src/config", () => ({ sessionId: "00000000-0000-4000-8000-000000000000" }));
const { handleChatMessage } = await import("../src/transport/chatMessages");
const { uploadFiles } = await import("../src/transport/upload");

let n = 0;
const key = () => `k${++n}`;
const apply = (state: ConversationState, ...actions: Action[]) => actions.reduce(conversationReducer, state);

const serial: InputRequest = { type: ChatServerMessageType.INPUT_REQUEST, id: "req_serialNumber_1", field: "serialNumber", kind: InputKind.TEXT, label: "Serial number or IMEI", required: true };
const stop: InputRequest = { type: ChatServerMessageType.INPUT_REQUEST, id: "req_optOutConfirmation_1", field: "optOutConfirmation", kind: InputKind.CONFIRM, label: "Stop your claim?", required: true };
const server = (spec: InputRequest): Action => ({ type: ActionType.SHOW_CARD, spec, key: key(), preempt: true });
const prompts = (state: ConversationState) => state.items.filter((item) => item.kind === ThreadItemKind.PROMPT).map((item) => (item.kind === ThreadItemKind.PROMPT ? item.spec.id : ""));

describe("a server card pre-empts the shown one (P4-T05)", () => {
  it("Stop: the confirm card replaces the open card, which is paused (not queued) and its prompt removed", () => {
    const state = apply(initialState(), server(serial), server(stop));
    expect(selectOpenCard(state)?.spec.id).toBe(stop.id);
    expect(state.cards[serial.id]?.status).toBe(CardStatus.PAUSED);
    expect(state.queue).toEqual([]);
    expect(prompts(state)).toEqual([]); // the serial prompt is gone (the confirm card is a choice card: no prompt)
  });

  it("No: answering the confirm card opens nothing by itself; the server's resume brings the same card back", () => {
    let state = apply(initialState(), server(serial), server(stop));
    state = apply(state, { type: ActionType.SUBMIT_CARD, id: stop.id, answer: { value: false, display: "No" }, key: key(), time: "10:00" });
    expect(selectOpenCard(state)).toBeNull();
    state = apply(state, server(serial)); // input.resumed: same id
    expect(selectOpenCard(state)?.spec.id).toBe(serial.id);
    expect(state.cards[serial.id]?.status).toBe(CardStatus.OPEN);
    expect(prompts(state)).toEqual([serial.id]);
  });

  it("Yes: the paused card never reappears; the server's cancel closes it quietly", () => {
    let state = apply(initialState(), server(serial), server(stop));
    state = apply(state, { type: ActionType.SUBMIT_CARD, id: stop.id, answer: { value: true, display: "Yes" }, key: key(), time: "10:00" });
    expect(selectOpenCard(state)).toBeNull();
    const notes = state.items.filter((item) => item.kind === ThreadItemKind.NOTE).length;
    state = apply(state, { type: ActionType.CANCEL_CARD, id: serial.id, reason: "the claim is closed", key: key() });
    expect(state.cards[serial.id]?.status).toBe(CardStatus.CANCELLED);
    expect(state.items.filter((item) => item.kind === ThreadItemKind.NOTE)).toHaveLength(notes); // no "no longer needed" note
    expect(selectOpenCard(state)).toBeNull();
  });

  it("the replay's open card is not re-opened while it is already open; a submitted one is left to syncCards", () => {
    const open = apply(initialState(), server(serial));
    expect(apply(open, server(serial))).toBe(open);
    const submitted = apply(open, { type: ActionType.SUBMIT_CARD, id: serial.id, answer: { value: "x" }, key: key(), time: "10:00" });
    expect(apply(submitted, server(serial))).toBe(submitted);
  });

  it("after a reconnect, the server's open card replaces a stale one, which syncDone then closes", () => {
    let state = apply(initialState(), server(serial));
    state = apply(state, server(stop)); // the replay sends the server's open card
    state = apply(state, { type: ActionType.SYNC_CARDS, open: [stop.id], key: key() });
    expect(selectOpenCard(state)?.spec.id).toBe(stop.id);
    // The paused card is the server's queued one, not shown and not cancelled: the resume brings it back later.
    expect(state.cards[serial.id]?.status).toBe(CardStatus.PAUSED);
  });

  it("without preempt (the demo), cards still queue behind the open one as in the starter", () => {
    const state = apply(initialState(), { type: ActionType.SHOW_CARD, spec: serial, key: key() }, { type: ActionType.SHOW_CARD, spec: stop, key: key() });
    expect(selectOpenCard(state)?.spec.id).toBe(serial.id);
    expect(state.queue).toEqual([stop.id]);
  });

  it("the /chat transport marks every inputRequest as the server's (preempt)", () => {
    const calls: unknown[][] = [];
    const ui = { showInputCard: (...args: unknown[]) => calls.push(args) } as unknown as Ui;
    handleChatMessage(ui, JSON.stringify(serial));
    expect(calls).toEqual([[serial, { preempt: true }]]);
  });
});

describe("session status (the Stop button is offered only while the claim is active)", () => {
  it("SET_SESSION keeps the latest status and is a no-op when unchanged", () => {
    const active = apply(initialState(), { type: ActionType.SET_SESSION, status: "active" });
    expect(active.sessionStatus).toBe("active");
    expect(apply(active, { type: ActionType.SET_SESSION, status: "active" })).toBe(active);
    expect(apply(active, { type: ActionType.SET_SESSION, status: "finalized" }).sessionStatus).toBe("finalized");
    expect(initialState().sessionStatus).toBeNull();
  });
});

describe("close codes and links (P4-T06)", () => {
  it("each refusal on /call reads as a sentence; an ordinary end has none", () => {
    expect(callCloseMessage(4429)).toBe("Voice is busy right now. You can continue here in chat.");
    expect(callCloseMessage(4403)).toBe("This page isn't allowed to connect to the voice server.");
    expect(callCloseMessage(4409)).toBe("A call is already active in another tab.");
    expect(callCloseMessage(4410)).toMatch(/^This claim is closed/);
    expect(callCloseMessage(4411)).toMatch(/resume/);
    expect(callCloseMessage(1000)).toBeNull();
    expect(callCloseMessage(1012)).toBeNull();
  });

  it("/chat's 4429 (new-session limit) says why while it keeps retrying; other closes keep the starter's notice", () => {
    expect(chatRetryNotice(4429, "wss://x/chat", 4)).toBe("Too many new claims were started from your network. Retrying in 4s…");
    expect(chatRetryNotice(1006, "wss://x/chat", 2)).toBe("Can't reach the chat server at wss://x/chat. Retrying in 2s…");
  });

  it("the copy-link button copies the page's link with its session id (no fragment)", () => {
    expect(sessionLink("https://repair.example.com/?sessionId=0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b#x")).toBe(
      "https://repair.example.com/?sessionId=0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b",
    );
  });
});

describe("upload errors (protocol.md §8)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const file = new File([new Uint8Array([1, 2, 3])], "invoice.pdf", { type: "application/pdf" });

  it("shows the server's message when it sends one", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "too_large", message: "That file is larger than 10 MB." } }), { status: 413 }));
    await expect(uploadFiles({ http: "https://x", ws: "wss://x" }, [file], false)).rejects.toThrow("Upload of invoice.pdf failed: That file is larger than 10 MB.");
  });

  it("falls back to the status code, and returns the ref on success", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 502 }));
    await expect(uploadFiles({ http: "https://x", ws: "wss://x" }, [file], false)).rejects.toThrow("Upload of invoice.pdf failed (502).");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ url: "file:fAbc12345" }), { status: 200 }));
    await expect(uploadFiles({ http: "https://x", ws: "wss://x" }, [file], true)).resolves.toEqual(["file:fAbc12345"]);
  });
});

describe("P4 review #1: a late answer to a card the Stop flow paused", () => {
  it("the stale error briefly reopens the old card, then the re-sent open card takes over and the old one waits", () => {
    let state = apply(initialState(), server(serial));
    state = apply(state, { type: ActionType.SUBMIT_CARD, id: serial.id, answer: { value: "file:x" }, key: key(), time: "10:00" }); // upload running
    state = apply(state, server(stop)); // Stop: the server's confirm card
    state = apply(state, { type: ActionType.REJECT_CARD, id: serial.id, message: "This request is no longer active.", key: key() });
    state = apply(state, server(stop)); // the server re-sends its open card after the error
    expect(selectOpenCard(state)?.spec.id).toBe(stop.id);
    expect(state.cards[serial.id]?.status).toBe(CardStatus.PAUSED);
    state = apply(state, { type: ActionType.SUBMIT_CARD, id: stop.id, answer: { value: false }, key: key(), time: "10:01" });
    state = apply(state, server(serial)); // resumed on No
    expect(selectOpenCard(state)?.spec.id).toBe(serial.id);
  });
});
