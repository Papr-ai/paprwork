import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30000, // 30s for integration tests
    hookTimeout: 30000,
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
