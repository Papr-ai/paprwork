#!/usr/bin/env node
/**
 * Repair hardcoded Papr paths after flat ~/Papr → org/namespace migration.
 *
 * Phases (in order):
 *   1. data-sources.json — dbPath via jobId (canonical job DB location)
 *   2. jobs.json — command / delegation fields → $JOB_DIR, $PAPR_HOME, …
 *   3. Jobs/{id}/code/* — job source scripts
 *   4. apps/{id}/* — mini-app source (conservative path rewrites)
 *
 * Safe to run repeatedly. Use --dry-run first to preview changes.
 *
 * Usage:
 *   npm run repair:post-migration -- --dry-run
 *   npm run repair:post-migration
 *   npm run repair:post-migration -- --skip-apps
 *   npm run repair:post-migration -- --delay-ms 50
 */

import {
  formatPostMigrationRepairSummary,
  runPostMigrationPathRepair,
} from "../src/gateway/services/postMigrationPathRepair.js";

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const skipApps = process.argv.includes("--skip-apps");
const delayArg = readFlagValue("--delay-ms");
const delayMs = delayArg ? Number.parseInt(delayArg, 10) : 15;

if (Number.isNaN(delayMs) || delayMs < 0) {
  console.error("[repair:post-migration] --delay-ms must be a non-negative integer");
  process.exit(1);
}

async function main() {
  const result = await runPostMigrationPathRepair({
    dryRun,
    includeApps: !skipApps,
    delayMs,
  });

  console.log(
    `[repair:post-migration] Done${dryRun ? " (dry-run)" : ""}. ` +
      formatPostMigrationRepairSummary(result),
  );

  if (!dryRun) {
    const totalChanges =
      result.dataSources.repairCount +
      result.jobsJson.repairedJobs +
      result.jobCode.repairedFiles +
      result.appSource.repairedFiles;

    if (totalChanges > 0) {
      console.log(
        "[repair:post-migration] Restart Paprwork so in-memory caches pick up repairs.",
      );
    }
  }
}

main().catch((error) => {
  console.error("[repair:post-migration] Failed:", error);
  process.exit(1);
});
