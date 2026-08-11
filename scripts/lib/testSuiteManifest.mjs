/**
 * Canonical test suite definition for Paprwork V2.
 * Used by run-all-tests-sequential.mjs and tests/README.md (keep in sync).
 */

/** @typedef {'ci' | 'local' | 'cloud' | 'full'} TestTier */

/** @typedef {'gateway' | 'memory' | 'cloudAppHost' | 'cloudAgentGateway' | 'auth' | 'anthropic'} ServiceRequirement */

/**
 * @typedef {object} TestStep
 * @property {string} id
 * @property {string} name
 * @property {TestTier[]} tiers
 * @property {string | null} npmScript npm run target (null = use `command`)
 * @property {string[] | null} command argv for custom runs
 * @property {ServiceRequirement[]} requires
 * @property {boolean} [continueOnFail] default false — stop suite on failure
 * @property {boolean} [optional] skip when requirements missing (don't fail suite)
 */

/** @type {Record<string, { port: number, healthPath: string, label: string }>} */
export const SERVICE_ENDPOINTS = {
  gateway: {
    port: 18789,
    healthPath: "/health",
    label: "Paprwork Gateway",
  },
  memory: {
    port: 5001,
    healthPath: "/health",
    label: "Memory server",
  },
  cloudAppHost: {
    port: 8787,
    healthPath: "/health",
    label: "Cloud App Host",
  },
  cloudAgentGateway: {
    port: 8788,
    healthPath: "/health",
    label: "Cloud Agent Gateway",
  },
};

/** Tier order — each tier includes all steps from lower tiers. */
export const TIER_ORDER = /** @type {const} */ (["ci", "local", "cloud", "full"]);

/** @type {TestStep[]} */
export const TEST_STEPS = [
  {
    id: "vitest",
    name: "Vitest (unit-backend + unit-ui + integration)",
    tiers: ["ci", "local", "cloud", "full"],
    npmScript: null,
    command: ["npm", "test"],
    requires: [],
  },
  {
    id: "build-gateway",
    name: "Build gateway (dist/)",
    tiers: ["ci", "local", "cloud", "full"],
    npmScript: "build:gateway",
    command: null,
    requires: [],
  },
  {
    id: "independent-databases-e2e",
    name: "Independent databases E2E (no HTTP)",
    tiers: ["ci", "local", "cloud", "full"],
    npmScript: "test:independent-databases-e2e",
    command: null,
    requires: [],
  },
  {
    id: "jobs-e2e",
    name: "Jobs E2E (bash, python, scheduling)",
    tiers: ["ci", "local", "cloud", "full"],
    npmScript: "test:jobs-e2e",
    command: null,
    requires: [],
  },
  {
    id: "jobs-advanced",
    name: "Jobs advanced E2E (agent jobs, restart, persistence)",
    tiers: ["ci", "local", "cloud", "full"],
    npmScript: "test:jobs-advanced",
    command: null,
    requires: [],
  },
  {
    id: "package-quick",
    name: "Package build config sanity",
    tiers: ["local", "cloud", "full"],
    npmScript: "test:package:quick",
    command: null,
    requires: [],
  },
  {
    id: "turso-delta-sync",
    name: "Turso delta sync (local + optional live)",
    tiers: ["local", "cloud", "full"],
    npmScript: "test:turso-delta-sync",
    command: null,
    requires: [],
    optional: true,
  },
  {
    id: "turso-sync-session-e2e",
    name: "Turso sync session E2E (scoped pull, skip, push-if-dirty)",
    tiers: ["local", "cloud", "full"],
    npmScript: "test:turso-sync-session-e2e",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "turso-sync-overlap-e2e",
    name: "Turso sync overlap E2E (no double push, db-changed pull, registry)",
    tiers: ["local", "cloud", "full"],
    npmScript: "test:turso-sync-overlap-e2e",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "turso-bidirectional-e2e",
    name: "Turso bidirectional merge E2E (push paths, watcher, sync-index, db-changed)",
    tiers: ["local", "cloud", "full"],
    npmScript: "test:turso-bidirectional-e2e",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "cloud-turso-db-changed-e2e",
    name: "Turso sync-index E2E (memory turso-db-changed → desktop hydrate)",
    tiers: ["cloud", "full"],
    npmScript: "test:cloud-turso-db-changed-e2e",
    command: null,
    requires: ["auth", "memory"],
    optional: true,
  },
  {
    id: "cloud-e2e",
    name: "Cloud proxy E2E (gateway → memory)",
    tiers: ["cloud", "full"],
    npmScript: "test:cloud-e2e",
    command: null,
    requires: ["gateway", "memory", "auth"],
  },
  {
    id: "cloud-sync",
    name: "Cloud git sync E2E",
    tiers: ["cloud", "full"],
    npmScript: "test:cloud-sync",
    command: null,
    requires: ["gateway", "memory", "auth"],
  },
  {
    id: "papr-sdk",
    name: "Papr SDK integration",
    tiers: ["cloud", "full"],
    npmScript: "test:papr-sdk",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "contribute-back-e2e",
    name: "Contribute-back PR E2E (fork install → propose → list)",
    tiers: ["cloud", "full"],
    npmScript: "test:contribute-back-e2e",
    command: null,
    requires: ["gateway", "memory", "auth"],
    optional: true,
  },
  {
    id: "track-pull-on-publish-e2e",
    name: "Track pull-on-publish E2E (stale revision → auto sync)",
    tiers: ["cloud", "full"],
    npmScript: "test:track-pull-on-publish-e2e",
    command: null,
    requires: ["gateway", "auth"],
    optional: true,
  },
  {
    id: "sync-phase4-5-e2e",
    name: "Phase 4+5 sync E2E (flushAppNow + SyncCoordinator + upload status)",
    tiers: ["cloud", "full"],
    npmScript: "test:sync-phase4-5-e2e",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "flush-web-ready-e2e",
    name: "Phase 4+5 sync E2E (alias: test:sync-phase4-5-e2e)",
    tiers: ["cloud", "full"],
    npmScript: "test:flush-web-ready-e2e",
    command: null,
    requires: ["auth"],
    optional: true,
  },
  {
    id: "cloud-app-host",
    name: "Cloud App Host E2E (publish + /api/db/query)",
    tiers: ["full"],
    npmScript: "test:cloud-app-host",
    command: null,
    requires: ["gateway", "memory", "auth", "cloudAppHost"],
    optional: true,
  },
  {
    id: "cloud-agent-job-e2e",
    name: "Cloud Agent Gateway job E2E (LLM + bash)",
    tiers: ["full"],
    npmScript: "test:cloud-agent-job-e2e",
    command: null,
    requires: ["memory", "auth", "anthropic", "cloudAgentGateway"],
    optional: true,
  },
];

/**
 * @param {TestTier} tier
 * @returns {TestStep[]}
 */
export function stepsForTier(tier) {
  const tierIndex = TIER_ORDER.indexOf(tier);
  if (tierIndex < 0) {
    throw new Error(`Unknown tier: ${tier}. Use: ${TIER_ORDER.join(", ")}`);
  }
  const allowed = new Set(TIER_ORDER.slice(0, tierIndex + 1));
  return TEST_STEPS.filter((step) => step.tiers.some((t) => allowed.has(t)));
}

/**
 * Services needed for a tier (union of step requirements).
 * @param {TestTier} tier
 * @returns {ServiceRequirement[]}
 */
export function servicesForTier(tier) {
  const steps = stepsForTier(tier);
  return [...new Set(steps.flatMap((s) => s.requires))];
}
