// The call in a real browser (P9-T02): the fake microphone really is captured and streamed (the server counts the frames),
// the agent's audio arrives (its words are in the thread), transcript lines update in place, and a hang-up hands over to
// the chat. The providers behind the server are fakes: this proves the browser seam, not Deepgram or the model.
import { expect, test } from "@playwright/test";
import { baseUrl, fresh, interim, say, script, stats } from "./support/control.js";
import { expectOpen } from "./support/ui.js";

test.beforeEach(async () => {
  await fresh();
});

const GREETING = "Hi, I'm Riya from device repairs. What's wrong with your device?";
const startCall = async (page: import("@playwright/test").Page) => {
  await script({ text: GREETING });
  await page.goto(`${baseUrl()}/`);
  await page.getByRole("button", { name: "Start call" }).click();
};

test("the call connects: the microphone is streamed to the server and the agent's greeting arrives", async ({ page }) => {
  await startCall(page);
  await expect(page.getByRole("button", { name: "Hang up" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "on call" })).toBeVisible();
  // The fake microphone's frames (20 ms each) reach speech-to-text: half a second of audio at least.
  await expect.poll(async () => (await stats()).sttBytes, { timeout: 10_000 }).toBeGreaterThan(640 * 25);
  // The agent's words are on the page as a spoken line.
  const greeting = page.locator(".bubble.spoken.agent", { hasText: GREETING });
  await expect(greeting).toBeVisible();
  await expect.poll(async () => (await stats()).ttsStreams).toBeGreaterThanOrEqual(1);
});

test("a transcript line appears as the customer speaks and is replaced in place by the final text", async ({ page }) => {
  await startCall(page);
  await expect(page.locator(".bubble.spoken.agent", { hasText: GREETING })).toBeVisible();
  await script({ text: "Got it." });
  await interim("my phone");
  const user = page.locator(".bubble.spoken.user");
  await expect(user).toHaveCount(1);
  await expect(user).toHaveClass(/partial/); // interim
  await say("my phone screen goes black");
  await expect(user).toHaveCount(1); // the same line, not a second one
  await expect(user).not.toHaveClass(/partial/);
  await expect(user).toContainText("my phone screen goes black");
});

test("hanging up hands over to the chat: what the call collected isn't asked again, the next card opens", async ({ page }) => {
  await startCall(page);
  await expect(page.locator(".bubble.spoken.agent", { hasText: GREETING })).toBeVisible();
  await script({ toolCalls: [{ name: "save_field", args: { field: "deviceType", value: "smartphone", spoken_evidence: "it's my phone" } }] }, { text: "And which model is it?" });
  await say("It's my phone");
  await expect(page.locator(".bubble.spoken.agent", { hasText: "which model" })).toBeVisible();
  await page.getByRole("button", { name: "Hang up" }).click();
  await expect(page.getByRole("button", { name: "Start call" })).toBeVisible();
  // After a call the chat asks for the typed fields first; the device type was said, so it isn't a card.
  await expectOpen(page, "Serial number or IMEI", 5_000);
  await expect(page.locator(".card-label", { hasText: "What kind of device is it?" })).toHaveCount(0);
  // The call's lines stay in the thread.
  await expect(page.locator(".bubble.spoken.user", { hasText: "It's my phone" })).toBeVisible();
});

test("a card the agent sends during the call appears in the same thread, and answering it works while the call is on", async ({ page }) => {
  await startCall(page);
  await expect(page.locator(".bubble.spoken.agent", { hasText: GREETING })).toBeVisible();
  await script({ toolCalls: [{ name: "request_chat_input", args: { field: "serialNumber" } }] }, { text: "I've sent a box to the chat for the serial number." });
  await say("Where do I put the serial number?");
  await expectOpen(page, "Serial number or IMEI");
  await page.locator(".card input.pill").fill("352099001761481");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".bubble.user", { hasText: "352099001761481" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up" })).toBeVisible(); // still on the call
});
