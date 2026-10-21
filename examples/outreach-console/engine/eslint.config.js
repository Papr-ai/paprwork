import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', performance: 'readonly' },
    },
  },
  {
    // Papr mini-app: runs in the browser.
    files: ['apps/papr/bundle/apps/**/app.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { document: 'readonly', location: 'readonly', fetch: 'readonly', navigator: 'readonly', confirm: 'readonly', prompt: 'readonly', URLSearchParams: 'readonly', Intl: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly' },
    },
  },
  {
    // Papr backend handlers and jobs: run in Node.
    files: ['apps/papr/bundle/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', AbortSignal: 'readonly' },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
