import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // "source" resolves @voice-chat-agent/shared to its TypeScript source, so tests don't need a prior build.
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    include: ["{shared,web}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
