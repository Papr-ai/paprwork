import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    name: 'e2e',
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60000, // 60s for E2E tests
    hookTimeout: 60000,
    // Run E2E tests sequentially to avoid conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, './src/core'),
      '@main': path.resolve(__dirname, './src/main'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
      '@gateway': path.resolve(__dirname, './src/gateway'),
    },
  },
});
