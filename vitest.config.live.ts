import { defineConfig } from "vitest/config";

/** *.live.test.ts — real network / API keys. Run on demand, never in CI. */
export default defineConfig({
  test: {
    name: "live",
    include: ["tests/**/*.live.test.ts", "test/**/*.live.test.ts", "src/**/*.live.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup/defaultTempWorkspace.ts"],
    testTimeout: 120_000,
  },
});
