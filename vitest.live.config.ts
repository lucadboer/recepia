import { defineConfig } from "vitest/config";

// Live tests hit real external services (network + secrets). They are excluded
// from the default `pnpm test` and run only via `pnpm test:live` with LIVE_LLM=1.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
