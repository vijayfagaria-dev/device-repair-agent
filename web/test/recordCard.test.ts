// P6-T03 on the page: the record card appears in the thread when `record` arrives and is replaced in place (never
// duplicated) when a later revision arrives, whether live or in a reconnect's replay.
import { ChatServerMessageType, type FinalRecord, Outcome } from "@device-repair/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ActionType, type Action } from "../src/state/actions";
import { initialState, ThreadItemKind, type ConversationState } from "../src/state/conversation";
import { conversationReducer } from "../src/state/reducer";
import type { Ui } from "../src/state/ui";

vi.mock("../src/config", () => ({ sessionId: "00000000-0000-4000-8000-000000000000" }));
const { handleChatMessage } = await import("../src/transport/chatMessages");

const apply = (state: ConversationState, ...actions: Action[]) => actions.reduce(conversationReducer, state);
const record = (revision: number, outcome: Outcome): FinalRecord => ({ sessionId: "s", revision, outcome, fields: {} });
const show = (r: FinalRecord, key: string): Action => ({ type: ActionType.SHOW_RECORD, record: r, key });
const records = (state: ConversationState) => state.items.flatMap((item) => (item.kind === ThreadItemKind.RECORD ? [item] : []));

describe("record card", () => {
  it("is added once, then replaced in place by a later revision (same slot, newest content)", () => {
    let state = apply(initialState(), show(record(1, Outcome.PARTIAL), "a"));
    expect(records(state).map((r) => [r.key, r.record.revision])).toEqual([["a", 1]]);
    state = apply(state, { type: ActionType.ADD_MESSAGE, msg: { id: "m_x", role: "agent" as never, text: "later" }, key: "msg", time: "t" }, show(record(2, Outcome.COMPLETED), "b"));
    expect(records(state).map((r) => [r.key, r.record.revision, r.record.outcome])).toEqual([["a", 2, Outcome.COMPLETED]]);
    expect(state.items.findIndex((item) => item.kind === ThreadItemKind.RECORD)).toBeLessThan(state.items.length - 1); // stayed where it was
  });

  it("a record message from the server shows the card (live or replayed)", () => {
    const calls: FinalRecord[] = [];
    const ui = { showRecord: (r: FinalRecord) => calls.push(r) } as unknown as Ui;
    handleChatMessage(ui, JSON.stringify({ type: ChatServerMessageType.RECORD, id: "rec_2", record: record(2, Outcome.COMPLETED) }));
    expect(calls).toEqual([record(2, Outcome.COMPLETED)]);
  });
});
