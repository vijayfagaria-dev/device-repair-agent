// What a person does on the page, as helpers: answer whichever card is open the way a user would.
import { expect, type Page } from "@playwright/test";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
export const EXE = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary"), Buffer.alloc(200, 0)]);

export const fiveDaysAgo = (): string => new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The card labels the server sends (server/src/domain/fields.ts) and what to do with each. */
const TEXT: Record<string, string> = {
  "Which brand and model is it?": "Samsung Galaxy S23",
  "What's wrong with the device?": "The screen flickers and then goes black after a minute",
  "Serial number or IMEI": "352099001761481",
  "Your email address": "asha.rao@example.com",
};
const CHOICE_FIRST = new Set(["What kind of device is it?", "How soon do you need it back?", "Which service centre suits you?"]);
const SKIPPABLE = new Set(["Any photos of the device or the damage? (optional)", "Anything else the technician should know? (optional)"]);

/**
 * The open card's own label, found through the open card's form (never "the last label on the page": an answered bubble
 * has a label too, and right after an answer the last label is the previous card's). A text or file card's input has the
 * id `in-<request id>` and a <label for> pointing at it; a choice card's group is `aria-labelledby` its label.
 */
/** Resolves the open card's label text (the card's form must be showing). */
/** Asserts which card is open now (polling: a card takes a moment to replace the last one). */
export const expectOpen = (page: Page, label: string, timeout = 10_000) => expect.poll(() => openCardLabel(page, 300).catch(() => ""), { timeout }).toBe(label);

export async function openCardLabel(page: Page, timeout = 10_000): Promise<string> {
  await expect(page.locator("form.card").last()).toBeVisible({ timeout });
  const form = page.locator("form.card").last();
  // Every action below has its own short timeout: a locator action otherwise waits for an element that a card in the middle
  // of rendering doesn't have yet (and would wait for the whole test), instead of letting the caller poll again.
  const quick = { timeout: 500 };
  const group = form.locator("[aria-labelledby]");
  if ((await group.count()) > 0) {
    const labelId = (await group.first().getAttribute("aria-labelledby", quick)) ?? "";
    return (await page.locator(`[id="${labelId}"]`).first().textContent(quick))?.trim() ?? "";
  }
  const inputId = (await form.locator("input").first().getAttribute("id", quick)) ?? "";
  return (await page.locator(`label[for="${inputId}"]`).first().textContent(quick))?.trim() ?? "";
}

export const send = (page: Page) => page.getByRole("button", { name: "Send" });

/** Answers the open card (its label tells which). Returns the label answered. */
export async function answerOpenCard(page: Page, options: { file?: { name: string; mimeType: string; buffer: Buffer } } = {}): Promise<string> {
  const label = await openCardLabel(page);
  if (CHOICE_FIRST.has(label)) await page.locator(".card .choice").first().click();
  else if (label === "Submit your claim?") await page.locator(".card .choice", { hasText: "Yes" }).click();
  else if (label === "When did the problem start?") {
    await page.locator('.card input[type="date"]').fill(fiveDaysAgo());
    await send(page).click();
  } else if (label === "Upload your purchase invoice") {
    await page.locator('.card input[type="file"]').setInputFiles(options.file ?? { name: "invoice.pdf", mimeType: "application/pdf", buffer: PDF });
    await send(page).click();
  } else if (SKIPPABLE.has(label)) await send(page).click();
  else if (label in TEXT) {
    await page.locator(".card input.pill").fill(TEXT[label] as string);
    await send(page).click();
  } else throw new Error(`no script for the card "${label}"`);
  return label;
}

/** Answers cards until the one labelled `stopAt` is open (it is left open), or the record shows. */
export async function answerUntil(page: Page, stopAt: string | null): Promise<string[]> {
  const answered: string[] = [];
  for (let i = 0; i < 16; i++) {
    if (await page.getByRole("region", { name: "Final record" }).isVisible()) return answered;
    const label = await openCardLabel(page);
    if (label === stopAt) return answered;
    answered.push(await answerOpenCard(page));
    // The next card (or the record) replaces this one.
    await expect(async () => {
      const done = await page.getByRole("region", { name: "Final record" }).isVisible();
      const next = await openCardLabel(page, 300).catch(() => "");
      expect(done || next !== label).toBe(true);
    }).toPass({ timeout: 8_000 });
  }
  throw new Error("the flow did not end");
}
