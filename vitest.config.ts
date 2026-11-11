import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // "source" resolves @device-repair/shared to its TypeScript source, so tests don't need a prior build.
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    include: ["{shared,server,web}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["server/test/build.global.ts", "server/test/db.global.ts"],
    // P2 gate: the pure domain core keeps ≥ 90% branch coverage (`npm run test:coverage`, run in CI).
    coverage: {
      provider: "v8",
      include: ["server/src/domain/**"],
      reporter: ["text", "text-summary"],
      thresholds: { "server/src/domain/**": { branches: 90 } },
    },
  },
});
