// /?demo=1 still works (P1-T03): the scripted flow runs without a backend and ends in the record card.
import { expect, test } from "@playwright/test";
import { baseUrl } from "./support/control.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("the scripted demo plays through to the record card", async ({ page }) => {
  await page.goto(`${baseUrl()}/?demo=1&pace=0.05`);
  await page.getByRole("button", { name: "Start call" }).click();
  // The demo's own cards (it needs a user's answers) are answered by clicking through whatever it opens.
  for (let i = 0; i < 80; i++) {
    if (await page.getByRole("region", { name: "Final record" }).isVisible()) break;
    const yes = page.locator(".card .choice", { hasText: "Yes" });
    const choice = (await yes.count()) ? yes.first() : page.locator(".card .choice").first();
    const send = page.getByRole("button", { name: "Send" });
    if (await choice.isVisible().catch(() => false)) await choice.click();
    else if (await send.isVisible().catch(() => false)) {
      const file = page.locator('.card input[type="file"]');
      if (await file.count()) await file.setInputFiles({ name: "damage.png", mimeType: "image/png", buffer: PNG }); // the demo's photo card takes images
      else {
        const text = page.locator(".card input.pill");
        if (await text.count()) await text.fill("POL-123456"); // the demo card checks the format client-side
      }
      await send.click();
    }
    await page.waitForTimeout(250);
  }
  await expect(page.getByRole("region", { name: "Final record" })).toBeVisible({ timeout: 10_000 });
});
