// Full sessions through the real server (P9-T01): the chat socket, the call socket and the fake STT/LLM/TTS driven by
// one script, with the invariant checker (≤ 1 open card, one running call, contiguous events and revisions,
// schema-valid sanitized records, one outbox row per revision, append-only history) run after every step.
// What the fakes prove is the server's behaviour across both channels, not that any provider works.
import { Outcome } from "@device-repair/shared/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { upsertTimer } from "../../src/db/repos/timers.js";
import { listTranscriptLines } from "../../src/db/repos/transcriptLines.js";
import { ANSWERS, startChat } from "../helpers/chatFlow.js";
import { sleep } from "../helpers/seed.js";
import { type Chat, expectValidProtocol, FIVE_VOICE_FIELDS, FIVE_VOICE_WORDS, type Msg, Rig, type Run, save, waitFor } from "./driver.js";

let rig: Rig;
beforeAll(async () => {
  rig = await Rig.create("fullsessions");
});
afterAll(async () => {
  await rig.close();
});

const NO_CALL_ORDER = ["deviceType", "deviceModel", "problemDescription", "problemStartedAt", "urgency", "serialNumber", "purchaseInvoice", "serviceCentre", "email"] as const;

/** A session whose chat has started without a call (the noCallStart deadline passed, PD10). */
async function chatOnlyRun(): Promise<Run> {
  const run = await rig.newRun();
  await startChat(rig.db, rig.services, run.id);
  return run;
}

/** The idle timer fires, as the sweeper would dispatch it. */
async function fireIdle(run: Run) {
  await upsertTimer(rig.db.pool, { sessionId: run.id, kind: "idle", dueAt: new Date(Date.now() - 1000) });
  await rig.services.processor.dispatch(run.id, { type: "TimerFired", kind: "idle", dueAt: new Date() } as never);
  await run.step("after the idle timer");
}

/** Answers every card that comes, until none does (for flows that never offer Submit claim?). */
async function answerWhatComes(chat: Chat): Promise<string[]> {
  const answered: string[] = [];
  for (let i = 0; i < 14; i++) {
    let card: Msg;
    try {
      card = await chat.until((m) => m.type === "inputRequest", 700);
    } catch {
      return answered;
    }
    expect(card.field, "no Submit claim? in this flow").not.toBe("submitConfirmation");
    await chat.answer(card, card.field === "purchaseInvoice" ? await chat.upload() : ANSWERS[card.field as string] ?? null);
    answered.push(card.field as string);
  }
  return answered;
}

async function confirm(run: Run, yes = true): Promise<Msg> {
  const card = await run.chat.card("submitConfirmation");
  await run.chat.answer(card, yes);
  return run.chat.until((m) => m.type === "record");
}

/** A call where the model saves all five voice fields and then asks the user to use the chat for the serial number. */
async function voiceCallWithFields(run: Run, extraFirstTurn: Parameters<typeof save>[] = []) {
  const call = await run.startCall();
  await call.say(
    FIVE_VOICE_WORDS,
    { toolCalls: [...(FIVE_VOICE_FIELDS.toolCalls ?? []), ...extraFirstTurn.map((args) => save(...args))] },
    { toolCalls: [{ name: "request_chat_input", args: { field: "serialNumber" } }] },
    { text: "I've sent a box to the chat for your serial number. Please type it in there." },
  );
  return call;
}

describe("happy path", () => {
  it("call collects the voice fields and sends a card; hang-up; chat finishes; confirmed → completed rev 1", async () => {
    const run = await rig.newRun();
    const call = await voiceCallWithFields(run);
    const first = await run.chat.card("serialNumber"); // the card the agent sent while the call is on
    expect(first.id).toBe("req_serialNumber_1");
    await run.chat.answer(first, ANSWERS.serialNumber);
    await run.chat.until((m) => m.type === "message" && m.role === "user");
    await call.hangUp();

    await run.chat.fillRest();
    const record = await confirm(run);
    expect(record.record).toMatchObject({ revision: 1, outcome: Outcome.COMPLETED, missingRequired: [], engagement: { calls: 1 } });
    const fields = (record.record as { fields: Record<string, { source: string; status: string }> }).fields;
    expect(fields.deviceModel).toMatchObject({ source: "call", status: "valid" });
    expect(fields.serialNumber).toMatchObject({ source: "chat", status: "valid" });
    // The call's words are on file, both sides (the customer spoke over the greeting: that is barge-in, so it is cut).
    const lines = await listTranscriptLines(rig.db.pool, run.id);
    expect(new Set(lines.map((l) => l.role))).toEqual(new Set(["agent", "user"]));
    expect(lines.filter((l) => l.role === "user")[0]?.text).toBe(FIVE_VOICE_WORDS);
    await run.step("at the end");
    expectValidProtocol(run.chat.all);
    run.chat.close();
  }, 30_000);

  it("a hang-up mid-way: the chat asks for what the call didn't get, and completes", async () => {
    const run = await rig.newRun();
    const call = await run.startCall();
    await call.say("It's my phone", { toolCalls: [save("deviceType", "smartphone", "it's my phone")] }, { text: "And which model is it?" });
    await call.hangUp();
    const first = await run.chat.card();
    expect(first.field).not.toBe("deviceType"); // not asked again
    // Whatever the planner needs next, the chat finishes the claim.
    await run.chat.answer(first, first.field === "purchaseInvoice" ? await run.chat.upload() : ANSWERS[first.field as string] ?? null);
    await run.chat.fillRest();
    const record = await confirm(run);
    expect(record.record).toMatchObject({ outcome: "completed", revision: 1 });
    expect((await listFieldCandidates(rig.db.pool, run.id, "deviceType"))[0]).toMatchObject({ source: "call" });
    run.chat.close();
  }, 30_000);

  it("chat-only (no call at all) completes", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER) await run.chat.give(field);
    await run.chat.fillRest();
    expect((await confirm(run)).record).toMatchObject({ outcome: "completed", engagement: { calls: 0 } });
    await run.step("at the end");
    run.chat.close();
  }, 30_000);
});

describe("outcomes", () => {
  it("an invalid serial number ×3 → the field stays invalid, no confirmation is offered, and idle → needsReview (R-3)", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER.slice(0, 5)) await run.chat.give(field);
    const card = await run.chat.card("serialNumber");
    for (let i = 0; i < 3; i++) {
      await run.chat.answer(card, "nope");
      if (i < 2) await run.chat.until((m) => m.type === "inputError");
    }
    await run.chat.until((m) => m.type === "inputCancel" && m.requestId === card.id);
    const rest = await answerWhatComes(run.chat);
    expect(rest).not.toContain("serialNumber");
    await fireIdle(run);
    const [record] = await run.records();
    expect(record?.outcome).toBe(Outcome.NEEDS_REVIEW);
    expect(record?.payload.reviewFlags).toEqual([expect.objectContaining({ rule: "R-3" })]);
    const fields = (record?.payload.fields ?? {}) as Record<string, { status: string }>;
    expect(fields.serialNumber?.status).toBe("invalid");
    run.chat.close();
  }, 30_000);

  it("a serial number never provided + idle → partial, naming it, with its card still open", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER.slice(0, 5)) await run.chat.give(field);
    await run.chat.card("serialNumber");
    await fireIdle(run);
    const [record] = await run.records();
    expect(record).toMatchObject({ outcome: Outcome.PARTIAL });
    expect(record?.payload.missingRequired).toContain("serialNumber");
    expect((await run.session()).status).toBe("finalized");
    // A returning page still sees the card to carry on with.
    const again = await run.openChat();
    expect(again.all.filter((m) => m.type === "inputRequest").map((m) => m.field)).toEqual(["serialNumber"]);
    again.close();
    run.chat.close();
  }, 30_000);

  it("a safety hazard said on the call → flagged → needsReview (R-1) once the user confirms", async () => {
    const run = await rig.newRun();
    const call = await run.startCall();
    await call.say("The battery is swollen and it smells like burning", { toolCalls: [{ name: "flag_for_review", args: { kind: "safety", reason: "battery swelling and a burning smell" } }] }, { text: "That sounds dangerous. Please stop using it." });
    await call.hangUp();
    await run.chat.fillRest(); // every card from the first, up to Submit claim?
    const record = await confirm(run);
    expect(record.record).toMatchObject({ outcome: Outcome.NEEDS_REVIEW, reviewFlags: [{ rule: "R-1" }] });
    run.chat.close();
  }, 30_000);

  it("opt-out on the call (confirmed) → optedOut, the call ends, the chat says so", async () => {
    const run = await rig.newRun();
    const call = await run.startCall();
    // Opting out ends the call with the server's own goodbye: the model gets no follow-up turn.
    await call.say("Actually, stop. I don't want to continue", { toolCalls: [{ name: "opt_out", args: { confirmed: true } }] });
    await waitFor(async () => (await run.session()).status === "finalized", "the opt-out to finalize");
    await waitFor(async () => (await run.session()).activeCallId === null, "the call to end");
    await run.step("after the opt-out");
    expect((await run.records())[0]).toMatchObject({ outcome: Outcome.OPTED_OUT });
    await run.chat.until((m) => m.type === "record");
    run.chat.close();
  }, 30_000);

  it("opt-out in the chat (Stop, then Yes) → optedOut with what was collected kept", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER.slice(0, 3)) await run.chat.give(field);
    await run.chat.card();
    run.chat.socket.ws.send(JSON.stringify({ type: "optOut" }));
    const stop = await run.chat.card("optOutConfirmation");
    await run.chat.answer(stop, true);
    const record = await run.chat.until((m) => m.type === "record");
    expect(record.record).toMatchObject({ outcome: "optedOut", revision: 1 });
    expect((record.record as { fields: Record<string, { status: string }> }).fields.deviceModel?.status).toBe("valid");
    run.chat.close();
  }, 30_000);

  it("an identifier conflict the user never resolved: spoken-and-confirmed vs typed → needsReview (R-2)", async () => {
    // NOTE: the "which is correct?" card (protocol.md §5 conflictChoice) is not implemented anywhere yet: no task owns
    // it. Until then an unresolved identifier conflict goes to review, which is what this asserts.
    const run = await rig.newRun();
    const call = await run.startCall();
    await call.say("My IMEI is 3 5 2 0 9 9 0 0 1 7 6 1 4 8 1", { toolCalls: [save("serialNumber", "352099001761481", "three five two ... four eight one", true)] }, { text: "Thanks, please type it in the chat." });
    await call.hangUp();
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const card = await run.chat.card();
      if (card.field === "submitConfirmation") {
        await run.chat.answer(card, true); // everything is valid, so the user confirms; the conflict decides the outcome
        break;
      }
      seen.push(card.field as string);
      const value = card.field === "serialNumber" ? "490154203237518" : card.field === "purchaseInvoice" ? await run.chat.upload() : ANSWERS[card.field as string] ?? null;
      await run.chat.answer(card, value);
    }
    expect(seen).toContain("serialNumber");
    const record = await run.chat.until((m) => m.type === "record");
    expect(record.record).toMatchObject({ outcome: Outcome.NEEDS_REVIEW, reviewFlags: [{ rule: "R-2" }], conflicts: [{ field: "serialNumber", resolution: "chatValue" }] });
    run.chat.close();
  }, 30_000);
});

describe("spoken versus typed", () => {
  it("a spoken email and a different typed email: the typed one wins and the conflict is recorded", async () => {
    const run = await rig.newRun();
    const call = await voiceCallWithFields(run, [["email", "asha@example.com", "asha at example dot com"]]);
    await call.hangUp();
    // The agent asks for the email to be typed (it never accepts a spoken one) and for the serial number: both cards.
    const typed: string[] = [];
    for (let i = 0; i < 12; i++) {
      const card = await run.chat.card();
      if (card.field === "submitConfirmation") {
        run.chat.skipToEnd();
        await run.chat.answer(card, true);
        break;
      }
      typed.push(card.field as string);
      await run.chat.answer(card, card.field === "purchaseInvoice" ? await run.chat.upload() : ANSWERS[card.field as string] ?? null);
    }
    expect(typed).toContain("email");
    const record = await run.chat.until((m) => m.type === "record");
    const body = record.record as { fields: Record<string, { value: unknown; source: string }>; conflicts: { field: string; resolution: string }[] };
    expect(body.fields.email).toMatchObject({ value: "asha.rao@example.com", source: "chat" });
    expect(body.conflicts).toEqual([expect.objectContaining({ field: "email", resolution: "chatValue" })]);
    run.chat.close();
  }, 30_000);

  it("a spoken email only: it stays unverified, its card is open and waiting, and the record says so", async () => {
    const run = await rig.newRun();
    const call = await voiceCallWithFields(run, [["email", "asha@example.com", "asha at example dot com"]]);
    await call.hangUp();
    const card = await run.chat.card(); // what the user was asked to type; they never do
    expect(card.field).toBe("email");
    await run.step("with the email card open");
    await fireIdle(run);
    const [record] = await run.records();
    expect(record?.outcome).toBe(Outcome.PARTIAL);
    const fields = (record?.payload.fields ?? {}) as Record<string, { status: string; value: unknown }>;
    expect(fields.email).toMatchObject({ status: "unverified", value: "asha@example.com" });
    expect(record?.payload.missingRequired).toContain("email");
    expect((await run.openChat()).all.filter((m) => m.type === "inputRequest").map((m) => m.field)).toEqual(["email"]); // kept open
    run.chat.close();
  }, 30_000);
});

describe("revisions", () => {
  it("idle → partial rev 1 → the user returns and finishes → completed rev 2; rev 1 is unchanged", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER.slice(0, 5)) await run.chat.give(field);
    const kept = await run.chat.card("serialNumber");
    await fireIdle(run);
    const rev1 = (await run.records())[0]?.payload;

    await run.chat.answer(kept, ANSWERS.serialNumber); // the card the partial session kept: the user is back
    await run.chat.until((m) => m.type === "message" && m.role === "user");
    expect((await run.session()).status).toBe("active");
    await run.chat.fillRest();
    const record = await confirm(run);
    expect(record.id).toBe("rec_2");
    expect(record.record).toMatchObject({ revision: 2, outcome: "completed", previousRevision: { revision: 1, outcome: "partial" } });
    const records = await run.records();
    expect(records.map((r) => r.revision)).toEqual([1, 2]);
    expect(records[0]?.payload).toEqual(rev1);
    await run.step("at the end");
    run.chat.close();
  }, 30_000);
});

describe("one conversation, several screens", () => {
  it("a double tap on a card is one answer", async () => {
    const run = await chatOnlyRun();
    const card = await run.chat.card();
    await run.chat.answer(card, ANSWERS[card.field as string]);
    run.chat.socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: card.id, field: card.field, value: ANSWERS[card.field as string] }));
    await run.chat.card();
    await sleep(100);
    expect(await listFieldCandidates(rig.db.pool, run.id, card.field as string)).toHaveLength(1);
    expect(run.chat.all.filter((m) => m.type === "message" && m.role === "user" && m.requestId === card.id)).toHaveLength(1);
    await run.step("after the double tap");
    run.chat.close();
  }, 30_000);

  it("a reload mid-session shows the same thread and the same open card, and the flow continues from there", async () => {
    const run = await chatOnlyRun();
    for (const field of NO_CALL_ORDER.slice(0, 4)) await run.chat.give(field);
    const open = await run.chat.card();
    const reload = await run.openChat();
    const thread = (messages: Msg[]) => messages.filter((m) => m.type === "message" || m.type === "transcript" || m.type === "inputRequest").map((m) => m.id);
    const live = thread(run.chat.all).filter((id) => !String(id).startsWith("req_") || id === open.id);
    expect(thread(reload.all)).toEqual(live);
    expectValidProtocol(reload.all);
    run.chat.close();
    const next = await reload.card();
    expect(next.id).toBe(open.id);
    await reload.answer(next, ANSWERS[next.field as string]);
    expect((await reload.card()).field).not.toBe(next.field);
    reload.close();
  }, 30_000);

  it("two tabs: an answer in one appears in the other with the next card, in the same order", async () => {
    const run = await chatOnlyRun();
    const other = await run.openChat();
    const card = await run.chat.card();
    await run.chat.answer(card, ANSWERS[card.field as string]);
    const next = await run.chat.card();
    const mirrored = await other.card(next.field as string);
    expect(mirrored.id).toBe(next.id);
    expect(other.all.filter((m) => m.type === "message" && m.role === "user").map((m) => m.text)).toEqual(run.chat.all.filter((m) => m.type === "message" && m.role === "user").map((m) => m.text));
    // The same card answered again from the other tab is the same answer (a repeat), not a second one.
    other.socket.ws.send(JSON.stringify({ type: "inputResponse", requestId: card.id, field: card.field, value: "other" }));
    await sleep(150);
    expect(await listFieldCandidates(rig.db.pool, run.id, card.field as string)).toHaveLength(1);
    await run.step("after both tabs");
    other.close();
    run.chat.close();
  }, 30_000);

  it("a returning call: its first turn knows what was collected, and the claim still completes", async () => {
    const run = await rig.newRun();
    const first = await voiceCallWithFields(run);
    await first.hangUp();
    rig.fresh(); // the second call has its own providers
    rig.llm.fallback = { text: "Okay." };
    const second = await run.startCall("Welcome back! Let's pick up where we left off.");
    const state = JSON.parse(String(rig.llm.requests[0]?.messages.at(-1)?.content).slice("STATE ".length));
    expect(state).toMatchObject({ isReturningCall: true });
    expect(state.missing).not.toContain("deviceModel");
    await second.hangUp();
    await run.chat.card("serialNumber").then((card) => run.chat.answer(card, ANSWERS.serialNumber));
    await run.chat.fillRest();
    expect((await confirm(run)).record).toMatchObject({ outcome: "completed", engagement: { calls: 2 } });
    run.chat.close();
  }, 40_000);
});
