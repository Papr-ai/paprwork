import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "unit-backend",
    globals: true,
    environment: "node",
    // Runs before test modules are imported, so modules that resolve the Papr
    // workspace at import time get a temp root instead of the developer's real
    // one. `useIsolatedPaprWorkspace()` still applies where a suite needs a
    // fresh workspace per test — this only makes the default safe.
    // Bundles db-query-worker.ts so LocalStorageProvider read workers can start.
    globalSetup: ["./tests/setup/buildDbQueryWorker.ts"],
    setupFiles: ["./tests/setup/defaultTempWorkspace.ts"],
    // Co-located `src/**` specs are included so tests living next to the code
    // they cover actually run in CI. Without this, repoHygiene.test.ts was
    // collected by no project and silently never executed.
    include: [
      "tests/**/*.{test,spec}.{js,ts}",
      "src/**/*.{test,spec}.{js,ts}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "**/ui/**",
      "tests/manual/**",
      // Tier by file name: *.build.test.ts needs dist/ (run after
      // build:gateway via test:build); *.live.test.ts hits real networks/keys
      // (test:live, never CI).
      "**/*.build.test.ts",
      "**/*.live.test.ts",
      // Legacy script/manual/live tests (not deterministic vitest suites)
      "tests/agent/agent-performance-scaling.test.ts",
      "tests/agent/bash-tool.test.ts",
      "tests/chat/chat-exporter.test.ts",
      "tests/chat/chat-session-manager.test.ts",
      "tests/chat/llm-streaming.test.ts",
      "tests/chat/local-storage.test.ts",
      "tests/memory/papr-sdk-integration.test.ts",
      "tests/chat/storage-manager.test.ts",
      "tests/chat/title-generation.test.ts",
      "tests/chat/chat-creation-flow.test.ts",
    ],
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
      "@gateway": path.resolve(__dirname, "./src/gateway"),
    },
  },
});
