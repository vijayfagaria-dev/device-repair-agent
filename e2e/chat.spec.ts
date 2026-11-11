// The chat side in a real browser (P9-T02): cards of each kind, an upload that is refused, the record card, a reload,
// the Stop flow. No call: the page's chat takes over by itself after the server's noCallStart deadline (PD10).
import { expect, test } from "@playwright/test";
import { baseUrl, fresh, records } from "./support/control.js";
import { answerOpenCard, answerUntil, EXE, expectOpen, send } from "./support/ui.js";

test.beforeEach(async () => {
  await fresh();
});

const sessionOf = (url: string) => new URL(url).searchParams.get("sessionId") as string;

test("text, select and file cards, one at a time, each answer becoming a bubble", async ({ page }) => {
  await page.goto(`${baseUrl()}/`);
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(page.getByText("No problem if you'd rather not call")).toBeVisible();

  // A select card: the choices are buttons, and the answer is a user bubble.
  await expectOpen(page, "What kind of device is it?");
  expect(await page.locator(".card").count()).toBe(1); // one card at a time
  await answerOpenCard(page);
  await expect(log.locator(".bubble.user").first()).toBeVisible();
  // A text card.
  await expectOpen(page, "Which brand and model is it?");
  await answerOpenCard(page);
  await expect(log.locator(".bubble.user", { hasText: "Samsung Galaxy S23" })).toBeVisible();
  // A date, another text and a select, up to the serial number and then the file card.
  await answerUntil(page, "Upload your purchase invoice");
  await expect(page.locator('.card input[type="file"]')).toHaveCount(1);
});

test("an upload the server refuses shows a message and keeps the card open", async ({ page }) => {
  await page.goto(`${baseUrl()}/`);
  await answerUntil(page, "Upload your purchase invoice");
  await page.locator('.card input[type="file"]').setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: EXE });
  await send(page).click();
  await expect(page.locator(".card-error")).toBeVisible();
  await expect(page.locator(".card-error")).not.toBeEmpty();
  await expectOpen(page, "Upload your purchase invoice"); // still the open card
  // A valid file then goes through.
  await answerOpenCard(page);
  await expectOpen(page, "Which service centre suits you?");
});

test("the whole claim in chat ends in the record card, completed", async ({ page }) => {
  await page.goto(`${baseUrl()}/`);
  await answerUntil(page, null);
  const record = page.getByRole("region", { name: "Final record" });
  await expect(record).toBeVisible();
  await expect(record).toContainText("completed");
  await expect(record).toContainText("rev 1");
  const id = sessionOf(page.url());
  await expect.poll(async () => (await records(id)).map((r) => [r.revision, r.outcome])).toEqual([[1, "completed"]]);
});

test("a reload restores the thread and the open card", async ({ page }) => {
  await page.goto(`${baseUrl()}/`);
  await answerUntil(page, "Serial number or IMEI");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.locator(".bubble.user", { hasText: "Samsung Galaxy S23" })).toBeVisible();
  // The conversation (agent and user messages); the open card's prompt is page-local and comes back with the card.
  // Each bubble's last line, minus the clock stamp: live, an answer bubble also shows its question's label; a reload
  // shows the answer alone (the label is page-local), so the label line is not compared.
  const thread = async () =>
    (await log.locator(".bubble:not(.prompt)").allInnerTexts()).map((t) => {
      const lines = t.replace(/\s*\d{1,2}:\d{2}\s?[AP]M\s*$/i, "").trim().split("\n");
      return (lines.at(-1) ?? "").trim();
    });
  const before = await thread();
  await page.reload();
  await expectOpen(page, "Serial number or IMEI");
  await expect(log.locator(".bubble.user", { hasText: "Samsung Galaxy S23" })).toBeVisible();
  expect(await thread()).toEqual(before); // the same thread, nothing doubled
  expect(await page.locator(".card").count()).toBe(1);
  // And the flow goes on from there.
  await answerOpenCard(page);
  await expectOpen(page, "Upload your purchase invoice");
});

test("the Stop flow: Stop → confirm → the claim is optedOut and the record says so", async ({ page }) => {
  await page.goto(`${baseUrl()}/`);
  await answerUntil(page, "Serial number or IMEI");
  await page.getByRole("button", { name: "Stop" }).click();
  await expectOpen(page, "Stop your claim?");
  await page.locator(".card .choice", { hasText: "Yes" }).click();
  const record = page.getByRole("region", { name: "Final record" });
  await expect(record).toContainText("optedOut");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0); // nothing left to stop
  const id = sessionOf(page.url());
  await expect.poll(async () => (await records(id)).map((r) => r.outcome)).toEqual(["optedOut"]);
});
