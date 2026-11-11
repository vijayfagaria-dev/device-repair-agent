// Helpers for P4 chat-flow tests: start a session's chat the way production does (the noCallStart timer fires),
// answer cards through the real SubmitChatInput handler, and read what is open.
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db/pool.js";
import { insertFile, type StoredFile } from "../../src/db/repos/files.js";
import { getOpenInputRequest, listInputRequests, type StoredInputRequest } from "../../src/db/repos/inputRequests.js";
import { lockSession } from "../../src/db/repos/sessions.js";
import { upsertTimer } from "../../src/db/repos/timers.js";
import { withTx } from "../../src/db/tx.js";
import type { SubmitChatInputReply } from "../../src/session/handlers/chatInput.js";
import type { SessionServices } from "../../src/session/services.js";
import { seedSession } from "./seed.js";

/** A small real PDF (magic bytes are what count). */
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
/** A 1×1 PNG. */
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
/** A Windows executable header (MZ) renamed to .pdf. */
export const EXE = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary"), Buffer.alloc(200, 0)]);

/** Fires the session's noCallStart timer now (PD10): the chat starts and the planner opens the first card. */
export async function startChat(db: Database, services: SessionServices, sessionId: string): Promise<void> {
  await upsertTimer(db.pool, { sessionId, kind: "noCallStart", dueAt: new Date(Date.now() - 1000) });
  await services.processor.dispatch(sessionId, { type: "TimerFired", kind: "noCallStart", dueAt: new Date() } as never);
}

/** A new session whose chat has started. */
export async function chatSession(db: Database, services: SessionServices): Promise<string> {
  const id = await seedSession(db.pool);
  await startChat(db, services, id);
  return id;
}

export const openCard = (db: Database, sessionId: string): Promise<StoredInputRequest | null> => getOpenInputRequest(db.pool, sessionId);
export const cards = (db: Database, sessionId: string) => listInputRequests(db.pool, sessionId);

export async function answer(services: SessionServices, sessionId: string, requestId: string, field: string, value: unknown): Promise<SubmitChatInputReply | undefined> {
  const { reply } = await services.processor.dispatch<SubmitChatInputReply>(sessionId, { type: "SubmitChatInput", requestId, field, value } as never);
  return reply;
}

/** Answers whatever card is open (it must be for `field`). */
export async function answerOpen(db: Database, services: SessionServices, sessionId: string, field: string, value: unknown): Promise<SubmitChatInputReply | undefined> {
  const open = await openCard(db, sessionId);
  if (open?.field !== field) throw new Error(`expected the open card to be ${field}, got ${open?.field ?? "none"}`);
  return answer(services, sessionId, open.id, field, value);
}

/** Stores an upload for the session directly (the HTTP endpoint is tested in http/files.test.ts). */
export async function storeTestFile(db: Database, sessionId: string, bytes = PDF, mime: StoredFile["mime"] = "application/pdf", name = "invoice.pdf"): Promise<StoredFile> {
  return withTx(db.pool, async (tx) => {
    await lockSession(tx, sessionId);
    return insertFile(tx, { id: `f${randomUUID().replace(/-/g, "").slice(0, 16)}`, sessionId, mime, bytes, originalName: name });
  });
}

/** Valid chat answers for every card the planner can open, by field (file cards need a stored file). */
export const ANSWERS: Record<string, unknown> = {
  deviceType: "smartphone",
  deviceModel: "Samsung Galaxy S23",
  problemDescription: "The screen flickers and then goes black after a minute",
  // Five days ago (IST is at most a day ahead of UTC), so it is never "in the future" whatever the clock says.
  problemStartedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  urgency: "high",
  serialNumber: "35-209900-176148-1",
  serviceCentre: "blr-koramangala",
  email: "asha.rao@example.com",
  additionalPhotos: null,
  additionalNotes: null,
};

/** A session whose chat has started and whose open card is for `field` (the cards before it answered validly). */
export async function sessionAtField(db: Database, services: SessionServices, field: string): Promise<string> {
  const id = await chatSession(db, services);
  for (let i = 0; i < 12; i++) {
    const open = await openCard(db, id);
    if (!open) throw new Error("no open card");
    if (open.field === field) return id;
    let value = ANSWERS[open.field];
    if (open.field === "purchaseInvoice") value = `file:${(await storeTestFile(db, id)).id}`;
    await answer(services, id, open.id, open.field, value);
  }
  throw new Error(`never reached ${field}`);
}
