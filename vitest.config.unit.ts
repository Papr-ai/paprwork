import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node", // Node environment for backend tests
    include: ["tests/**/*.{test,spec}.{js,ts}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "**/ui/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "src/core/**/*.ts",
        "src/gateway/**/*.ts",
      ],
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
