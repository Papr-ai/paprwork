import { defineConfig } from "vitest/config";

/** *.build.test.ts — needs dist/ from `npm run build:gateway`. Runs after it in CI. */
export default defineConfig({
  test: {
    name: "build",
    include: ["tests/**/*.build.test.ts", "src/**/*.build.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup/defaultTempWorkspace.ts"],
  },
});
