# Testing Suites

This project now uses a layered, predictable test strategy.

## Default Fast Suite

- `npm test` (alias for `npm run test:standard`)
- `npm run test:standard`

Runs:
- backend unit tests (`vitest.config.unit.ts`)
- stable UI unit tests (`ui/vitest.config.ts`)

Use this for day-to-day development and PR checks.

## Individual Suites

- `npm run test:unit:backend`
  - backend/unit tests in `tests/`
- `npm run test:unit:ui`
  - UI unit tests in `ui/__tests__/` (stable subset)
- `npm run test:integration`
  - integration suite config, gated by env flag (no-op unless enabled)
- `npm run test:e2e`
  - e2e suite config, gated by env flag (no-op unless enabled)

## Full Environment-Dependent Suites

- `npm run test:integration:run`
  - enables integration tests (`PAPR_RUN_INTEGRATION=1`)
- `npm run test:e2e:run`
  - enables e2e tests (`PAPR_RUN_E2E=1`)
- `npm run test:all:full`
  - standard + integration + e2e (all enabled)

## Aggregates

- `npm run test:all`
  - standard + gated integration/e2e configs (safe on most machines)

## Notes

- Integration tests currently require native/runtime prerequisites (for example compatible `better-sqlite3` binary for the active Node runtime).
- E2E tests require a build/runtime environment compatible with Playwright + Electron launch.
- Live/manual scripts remain outside the standard suite and should be run intentionally.
