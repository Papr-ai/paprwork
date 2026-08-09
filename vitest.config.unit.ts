import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "unit-backend",
    globals: true,
    environment: "node",
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
      // Legacy script/manual/live tests (not deterministic vitest suites)
      "tests/agent-performance-scaling.test.ts",
      "tests/bash-tool.test.ts",
      "tests/chat-exporter.test.ts",
      "tests/chat-session-manager.test.ts",
      "tests/llm-streaming.test.ts",
      "tests/local-storage.test.ts",
      "tests/papr-sdk-integration.test.ts",
      "tests/storage-manager.test.ts",
      "tests/title-generation.test.ts",
      "tests/security-manual-test.ts",
      "tests/papr-connection-test.ts",
      "tests/papr-summarization-test.ts",
      "tests/test-tab-activation.ts",
      "tests/test-chat-flow.ts",
      "tests/chat-creation-flow.test.ts",
      "tests/keychain-fix-test.ts",
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
