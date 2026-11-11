// Browser E2E (P9-T02): the real built UI in Chromium against a real server whose providers are fakes (so no key, no
// cost, and the model says what the spec scripts). Microphone: Chromium's fake device plays a WAV, so the capture →
// worklet → WebSocket path is real, and the server counts the frames that arrive.
//   npm run e2e                      (builds first)
//   PW_CHANNEL=chrome npm run e2e    (use the installed Google Chrome instead of Playwright's Chromium)
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const WAV = fileURLToPath(new URL("./e2e/fixtures/mic-tone-then-silence.wav", import.meta.url));

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One worker: each spec file starts its own in-process server, and the specs script that server's fakes directly.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    channel: process.env.PW_CHANNEL || undefined,
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"],
    },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
