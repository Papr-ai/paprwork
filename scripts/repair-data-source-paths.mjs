#!/usr/bin/env node
/**
 * Repair stale absolute dbPath values in data-sources.json across all Papr workspaces.
 *
 * Safe to run repeatedly — only rewrites paths when the canonical job database exists
 * at a different location (common after org/namespace workspace migration).
 *
 * Does not require Gateway. Yields between apps so long scans stay lightweight.
 *
 * Usage:
 *   npm run repair:data-sources
 *   npm run repair:data-sources -- --dry-run
 *   npm run repair:data-sources -- --delay-ms 100
 */

import { runGlobalDataSourcePathRepair } from "../src/gateway/services/dataSourcePathRepairScan.js";

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const delayArg = readFlagValue("--delay-ms");
const delayMs = delayArg ? Number.parseInt(delayArg, 10) : 25;

if (Number.isNaN(delayMs) || delayMs < 0) {
  console.error("[repair:data-sources] --delay-ms must be a non-negative integer");
  process.exit(1);
}

async function main() {
  console.log(
    `[repair:data-sources] Scanning all workspaces${dryRun ? " (dry-run)" : ""}…`,
  );

  const result = await runGlobalDataSourcePathRepair({ dryRun, delayMs });

  console.log(
    `[repair:data-sources] Done. scanned=${result.scannedApps} ` +
      `repairedApps=${result.repairedApps} repairs=${result.repairCount}`,
  );

  if (result.repairCount > 0 && !dryRun) {
    console.log(
      "[repair:data-sources] Restart Paprwork (or wait for background repair) so in-memory caches refresh.",
    );
  }
}

main().catch((error) => {
  console.error("[repair:data-sources] Failed:", error);
  process.exit(1);
});
