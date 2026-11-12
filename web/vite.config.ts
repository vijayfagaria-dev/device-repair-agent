import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // "source" makes Vite read @voice-chat-agent/shared from its TypeScript source, so the web build doesn't need shared/dist.
  resolve: { conditions: ["source", ...defaultClientConditions] },
});
