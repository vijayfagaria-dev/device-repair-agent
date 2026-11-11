// The security headers in a real browser (P10-T02): with the CSP on, the page still works end to end (script and the
// capture worklet load, the microphone is captured, the sockets connect, an image preview from a blob: URL renders),
// and Chromium reports no CSP violation while it does. The headers themselves are asserted on the page response.
import { expect, test } from "@playwright/test";
import { baseUrl, fresh, script, stats } from "./support/control.js";
import { answerUntil, send } from "./support/ui.js";

test.beforeEach(async () => {
  await fresh();
});

// A 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function watchForViolations(page: import("@playwright/test").Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(text)) violations.push(text);
  });
  page.on("pageerror", (error) => {
    if (/Content Security Policy/i.test(error.message)) violations.push(error.message);
  });
  return violations;
}

test("the page response carries the security headers", async ({ page }) => {
  const response = await page.goto(`${baseUrl()}/`);
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["content-security-policy"]).not.toContain("unsafe-");
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
});

test("with the CSP on, a call works (worklet, microphone, sockets) and no CSP violation is reported", async ({ page }) => {
  const violations = watchForViolations(page);
  await script({ text: "Hi, I'm Riya. What's wrong with your device?" });
  await page.goto(`${baseUrl()}/`);
  await page.getByRole("button", { name: "Start call" }).click();
  await expect(page.getByRole("button", { name: "Hang up" })).toBeVisible();
  // Audio only reaches the server through the AudioWorklet, so frames arriving proves the worklet module loaded.
  await expect.poll(async () => (await stats()).sttBytes, { timeout: 10_000 }).toBeGreaterThan(640 * 25);
  await expect(page.locator(".bubble.spoken.agent")).toBeVisible();
  await page.getByRole("button", { name: "Hang up" }).click();
  expect(violations).toEqual([]);
});

test("with the CSP on, the chat works and an uploaded image shows from a blob: URL", async ({ page }) => {
  const violations = watchForViolations(page);
  await page.goto(`${baseUrl()}/`);
  await answerUntil(page, "Upload your purchase invoice");
  await page.locator('.card input[type="file"]').setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: PNG });
  await send(page).click(); // the answer bubble shows the chosen image from its object URL
  const preview = page.locator(".bubble.user img");
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.src.startsWith("blob:") && img.complete && img.naturalWidth > 0)).toBe(true);
  expect(violations).toEqual([]);
});
