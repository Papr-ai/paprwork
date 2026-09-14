import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "integration",
    include: ["test/integration/**/*.{test,spec}.{js,ts}"],
    environment: "node",
    globals: true,
    // See tests/setup/defaultTempWorkspace.ts — the five integration suites
    // here resolved the workspace in `beforeAll` and so wrote to the real
    // `~/Papr`; two of them (agent-tracking, gateway-storage) asserted against
    // `os.homedir()/Papr` directly.
    setupFiles: ["./tests/setup/defaultTempWorkspace.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/core/**/*.ts", "src/gateway/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.ts",
        "**/node_modules/**",
        "**/dist/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "./src/core"),
      "@main": path.resolve(__dirname, "./src/main"),
      "@renderer": path.resolve(__dirname, "./src/renderer"),
      "@gateway": path.resolve(__dirname, "./src/gateway"),
    },
  },
});
