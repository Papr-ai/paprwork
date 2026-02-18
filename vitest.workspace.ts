import { defineWorkspace } from "vitest/config";

/**
 * Vitest Workspace Configuration
 *
 * Unified test suite orchestrating all test projects:
 *   - unit-backend: Core library + gateway service tests (Node environment)
 *   - unit-ui:      React component, store, and feature tests (happy-dom)
 *   - integration:  Gateway storage, WebSocket, agent streaming tests
 *   - e2e:          Full chat workflow end-to-end tests
 *
 * Usage:
 *   npm test                              → run ALL tests
 *   npm test -- --project unit-backend    → run only backend unit tests
 *   npm test -- --project unit-ui         → run only UI tests
 *   npm test -- --project integration     → run only integration tests
 *   npm test -- --project e2e             → run only e2e tests
 */
export default defineWorkspace([
  "vitest.config.unit.ts",
  "vitest.config.integration.ts",
  "vitest.config.e2e.ts",
  "ui/vitest.config.ts",
]);
