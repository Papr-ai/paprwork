import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so they never depend on a prior build.
    alias: [{ find: /^@splitin\/outreach-([a-z0-9-]+)$/, replacement: `${packagesDir}outreach-$1/src/index.ts` }],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
