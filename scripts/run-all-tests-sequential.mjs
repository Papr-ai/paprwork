#!/usr/bin/env node
/**
 * Sequential test runner — memory-project style orchestration for Paprwork V2.
 *
 * Usage:
 *   node scripts/run-all-tests-sequential.mjs [--tier=ci|local|cloud|full]
 *   node scripts/run-all-tests-sequential.mjs --tier=cloud --start-stack
 *   node scripts/run-all-tests-sequential.mjs --tier=full --start-stack --with-memory --with-cloud-host
 *
 * Tiers (each includes prior tiers):
 *   ci     — Vitest + jobs E2E (CI-safe, no running services)
 *   local  — ci + package sanity + turso local tests
 *   cloud  — local + cloud proxy/sync (needs gateway + memory + auth)
 *   full   — cloud + app host + agent gateway (needs full stack + API keys)
 *
 * Reports written to test_reports/paprwork_report_<timestamp>.json
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  stepsForTier,
  servicesForTier,
  TIER_ORDER,
} from "./lib/testSuiteManifest.mjs";
import {
  REPO_ROOT,
  REPORT_DIR,
  ensureStackDirs,
  checkRequirements,
  readStackState,
  startStack,
  stopStack,
  printStackStatus,
  DEFAULT_MEMORY_REPO,
} from "./lib/testStackLib.mjs";

const args = process.argv.slice(2);

function flagValue(prefix) {
  const match = args.find((a) => a.startsWith(`${prefix}=`));
  return match?.split("=").slice(1).join("=");
}

function hasFlag(name) {
  return args.includes(name);
}

/** @type {import('./lib/testSuiteManifest.mjs').TestTier} */
const tier = /** @type {import('./lib/testSuiteManifest.mjs').TestTier} */ (
  flagValue("--tier") ?? "ci"
);

if (!TIER_ORDER.includes(tier)) {
  console.error(`Invalid --tier=${tier}. Use: ${TIER_ORDER.join(", ")}`);
  process.exit(1);
}

const startStackFlag = hasFlag("--start-stack");
const stopStackFlag = hasFlag("--stop-stack");
const continueOnFail = hasFlag("--continue-on-fail");

/**
 * @param {import('./lib/testSuiteManifest.mjs').TestStep} step
 */
function runStep(step) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`▶ ${step.name}`);
  console.log(`${"=".repeat(70)}\n`);

  let status = "passed";
  let exitCode = 0;
  /** @type {string} */
  let output = "";

  if (step.npmScript) {
    const result = spawnSync("npm", ["run", step.npmScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: true,
      env: process.env,
    });
    exitCode = result.status ?? 1;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-8000);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } else if (step.command) {
    const [cmd, ...cmdArgs] = step.command;
    const result = spawnSync(cmd, cmdArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: true,
      env: process.env,
    });
    exitCode = result.status ?? 1;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-8000);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (exitCode !== 0) {
    status = "failed";
  }

  const durationMs = Date.now() - startMs;
  const icon = status === "passed" ? "✓" : "✗";
  console.log(`\n${icon} ${step.name} (${(durationMs / 1000).toFixed(1)}s)\n`);

  return {
    id: step.id,
    name: step.name,
    status,
    exitCode,
    durationMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    outputTail: output,
  };
}

async function main() {
  ensureStackDirs();
  const steps = stepsForTier(tier);
  const startedAt = new Date().toISOString();
  const suiteStart = Date.now();

  console.log(`\nPaprwork sequential test runner`);
  console.log(`Tier: ${tier} (${steps.length} steps)`);
  console.log(`Repo: ${REPO_ROOT}\n`);

  let managedStack = false;

  if (startStackFlag && tier !== "ci") {
    const services = servicesForTier(tier);
    const withMemoryLocal = hasFlag("--with-memory-local");
    const withMemoryDocker = hasFlag("--with-memory-docker") || hasFlag("--with-memory");
    console.log("Starting test stack for tier requirements...\n");
    try {
      await startStack({
        gateway: services.includes("gateway"),
        memoryLocal: withMemoryLocal,
        memoryDocker: withMemoryDocker,
        cloudAppHost: services.includes("cloudAppHost"),
        cloudAgentGateway: services.includes("cloudAgentGateway"),
        memoryRepoPath: flagValue("--memory-repo") ?? DEFAULT_MEMORY_REPO,
      });
      managedStack = true;
      await printStackStatus();
    } catch (error) {
      console.error("Failed to start stack:", error instanceof Error ? error.message : error);
      if (!continueOnFail) process.exit(1);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let failed = 0;
  let skipped = 0;
  let passed = 0;

  for (const step of steps) {
    if (step.requires.length > 0) {
      const reqStatus = await checkRequirements(step.requires);
      const missing = step.requires.filter((r) => !reqStatus[r]);

      if (missing.length > 0) {
        const msg = `Missing: ${missing.join(", ")}`;
        if (step.optional) {
          console.log(`\n⊘ SKIP (optional): ${step.name} — ${msg}\n`);
          results.push({
            id: step.id,
            name: step.name,
            status: "skipped",
            reason: msg,
            startedAt: new Date().toISOString(),
          });
          skipped++;
          continue;
        }

        console.error(`\n✗ BLOCKED: ${step.name} — ${msg}`);
        console.error("  Start services: npm run test:stack -- up --with-memory");
        console.error("  Or use Papr Work (npm start) + .env.local keys\n");
        results.push({
          id: step.id,
          name: step.name,
          status: "blocked",
          reason: msg,
          startedAt: new Date().toISOString(),
        });
        failed++;
        if (!continueOnFail) break;
        continue;
      }
    }

    const result = runStep(step);
    results.push(result);

    if (result.status === "passed") {
      passed++;
    } else {
      failed++;
      if (!continueOnFail && !step.continueOnFail) {
        console.error(`Stopping after failure in "${step.name}" (--continue-on-fail to override)`);
        break;
      }
    }
  }

  if (managedStack && stopStackFlag) {
    const state = readStackState();
    if (state) {
      console.log("\nStopping test stack...\n");
      await stopStack(state);
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - suiteStart;
  const stamp = finishedAt.replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = join(REPORT_DIR, `paprwork_report_${stamp}.json`);

  const report = {
    tier,
    startedAt,
    finishedAt,
    durationMs,
    summary: { passed, failed, skipped, total: results.length },
    results,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Report:  ${reportPath}`);
  console.log(`${"=".repeat(70)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
