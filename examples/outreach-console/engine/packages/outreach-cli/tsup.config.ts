import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
    // node:sqlite exists only with the protocol prefix.
    removeNodeProtocol: false,
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node22',
    removeNodeProtocol: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
