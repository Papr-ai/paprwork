#!/usr/bin/env node
/**
 * Test stack orchestrator — start/stop Paprwork test dependencies.
 *
 * Usage:
 *   node scripts/test-stack.mjs smoke [--full] [--with-memory-local] ...
 *   node scripts/test-stack.mjs up [--full] [--with-memory-local] [--with-memory-docker]
 *   node scripts/test-stack.mjs down
 *   node scripts/test-stack.mjs health
 *   node scripts/test-stack.mjs status
 *
 * Options:
 *   --with-memory-local   Start memory via poetry/python main.py (../memory, no Docker)
 *   --with-memory-docker  Start memory via docker-compose (../memory)
 *   --with-memory         Alias for --with-memory-docker
 *   --with-cloud-host     Start Cloud App Host (:8787)
 *   --with-agent-gateway  Start Cloud Agent Gateway (:8788)
 *   --full                Start gateway + cloud host + agent gateway (prod memory from .env.local)
 *   --memory-repo=PATH    Override memory repo path (default: ../memory)
 *   --no-gateway          Skip gateway (only extra services)
 *
 * Notes:
 *   - Gateway-only mode is enough for many cloud E2E scripts when Papr Work is NOT running.
 *   - Keychain auth still requires Electron (`npm start`) or PAPR_API_KEY in .env.local.
 *   - Memory docker requires Docker and the memory repo cloned alongside paprwork-v2.
 */

import { servicesForTier } from "./lib/testSuiteManifest.mjs";
import {
  readStackState,
  startStack,
  stopStack,
  printStackStatus,
  checkRequirement,
  DEFAULT_MEMORY_REPO,
} from "./lib/testStackLib.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "status";

function hasFlag(name) {
  return args.includes(name);
}

function flagValue(prefix) {
  const match = args.find((a) => a.startsWith(`${prefix}=`));
  return match?.split("=").slice(1).join("=");
}

function parseStackFlags() {
  const withMemoryLocal = hasFlag("--with-memory-local");
  const withMemoryDocker = hasFlag("--with-memory-docker") || hasFlag("--with-memory");
  const withCloudHost = hasFlag("--with-cloud-host");
  const withAgentGateway = hasFlag("--with-agent-gateway");
  const noGateway = hasFlag("--no-gateway");
  const memoryRepo = flagValue("--memory-repo") ?? DEFAULT_MEMORY_REPO;
  const full = hasFlag("--full");

  return {
    withMemoryLocal: full ? false : withMemoryLocal,
    withMemoryDocker: full ? false : withMemoryDocker,
    withCloudHost: full ? true : withCloudHost,
    withAgentGateway: full ? true : withAgentGateway,
    noGateway,
    memoryRepo,
    full,
  };
}

/** Services that must pass /health for this invocation. */
function requiredHealthChecks(flags) {
  /** @type {import('./lib/testSuiteManifest.mjs').ServiceRequirement[]} */
  const required = [];
  if (!flags.noGateway) required.push("gateway");
  required.push("memory", "auth");
  if (flags.withCloudHost || flags.full) required.push("cloudAppHost");
  if (flags.withAgentGateway || flags.full) required.push("cloudAgentGateway");
  return required;
}

async function cmdUp() {
  const flags = parseStackFlags();

  if (flags.withMemoryLocal && flags.withMemoryDocker) {
    console.error("Use only one of --with-memory-local or --with-memory-docker");
    process.exit(1);
  }

  const startGateway = !flags.noGateway;

  if (
    !startGateway &&
    !flags.withMemoryLocal &&
    !flags.withMemoryDocker &&
    !flags.withCloudHost &&
    !flags.withAgentGateway
  ) {
    console.error(
      "Nothing to start. Use --with-memory-local, --with-cloud-host, --with-agent-gateway, or --full.",
    );
    process.exit(1);
  }

  console.log("\nStarting test stack...\n");

  try {
    await startStack({
      gateway: startGateway,
      memoryLocal: flags.withMemoryLocal,
      memoryDocker: flags.withMemoryDocker,
      cloudAppHost: flags.withCloudHost,
      cloudAgentGateway: flags.withAgentGateway,
      memoryRepoPath: flags.memoryRepo,
    });
    console.log("\n✓ Test stack is up\n");
    await printStackStatus();
  } catch (error) {
    console.error("\n✗ Failed to start test stack:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function cmdDown() {
  const state = readStackState();
  if (!state) {
    console.log("No managed stack state — running kill:gateway for safety...");
    const { spawnSync } = await import("node:child_process");
    spawnSync("npm", ["run", "kill:gateway"], { stdio: "inherit", shell: true });
    return;
  }

  console.log("\nStopping test stack...\n");
  await stopStack(state);
  console.log("\n✓ Test stack stopped\n");
}

async function cmdHealth() {
  const state = readStackState();
  let allOk = true;

  console.log("\nHealth checks\n");

  for (const req of ["gateway", "memory", "cloudAppHost", "cloudAgentGateway", "auth"]) {
    const ok = await checkRequirement(/** @type {import('./lib/testSuiteManifest.mjs').ServiceRequirement} */ (req), state);
    console.log(`  ${ok ? "✓" : "✗"} ${req}`);
    if (!ok && (req === "gateway" || req === "memory")) {
      allOk = false;
    }
  }

  process.exit(allOk ? 0 : 1);
}

async function cmdStatus() {
  await printStackStatus();

  // Hint which tier is runnable
  for (const tier of ["ci", "local", "cloud", "full"]) {
    const reqs = servicesForTier(/** @type {import('./lib/testSuiteManifest.mjs').TestTier} */ (tier));
    const unique = [...new Set(reqs)];
    const checks = await Promise.all(unique.map((r) => checkRequirement(r)));
    const ready = unique.length === 0 || checks.every(Boolean);
    console.log(`  Tier "${tier}": ${ready ? "ready" : "missing requirements → " + unique.filter((_, i) => !checks[i]).join(", ")}`);
  }
  console.log("");
}

async function cmdSmoke() {
  const flags = parseStackFlags();
  const required = requiredHealthChecks(flags);

  await cmdUp();
  console.log("\nRunning health checks...\n");
  const state = readStackState();
  let allOk = true;

  for (const req of ["gateway", "memory", "cloudAppHost", "cloudAgentGateway", "auth"]) {
    const ok = await checkRequirement(/** @type {import('./lib/testSuiteManifest.mjs').ServiceRequirement} */ (req), state);
    const mustPass = required.includes(req);
    const label = mustPass ? req : `${req} (optional)`;
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok && mustPass) {
      allOk = false;
    }
  }

  console.log("\nTearing down stack...\n");
  await cmdDown();

  if (!allOk) {
    console.error("\n✗ Stack smoke test failed — one or more required services unhealthy\n");
    process.exit(1);
  }
  console.log("\n✓ Stack smoke test passed (up → health → down)\n");
}

async function main() {
  switch (command) {
    case "up":
      await cmdUp();
      break;
    case "down":
      await cmdDown();
      break;
    case "health":
      await cmdHealth();
      break;
    case "status":
      await cmdStatus();
      break;
    case "smoke":
      await cmdSmoke();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use: up | down | health | status | smoke");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
