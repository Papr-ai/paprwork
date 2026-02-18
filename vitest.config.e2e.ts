import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["test/e2e/**/*.{test,spec}.{js,ts}"],
    environment: "node",
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
