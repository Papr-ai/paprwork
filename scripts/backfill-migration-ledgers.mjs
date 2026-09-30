#!/usr/bin/env node
/**
 * One-time Turso migration ledger backfill (legacy cutover).
 *
 * Default target: Joe Coffee Intelligence (744f60d6… / d-0ff146f4).
 *
 * Usage:
 *   npm run backfill:migration-ledgers -- --dry-run
 *   npm run backfill:migration-ledgers -- --app-id=744f60d6-d57b-4be7-95fd-feb7115831b4
 *   npm run backfill:migration-ledgers -- --replica-id=d-0ff146f4
 *   npm run backfill:migration-ledgers -- --all
 *
 * Requires PAPR_API_KEY (env) or use npm run backfill:migration-ledgers:keychain
 */

import {
  formatMigrationLedgerBackfillSummary,
  runMigrationLedgerBackfill,
} from "../src/gateway/services/syncV3/backfillMigrationLedgers.js";

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const inline = process.argv[index].includes("=")
    ? process.argv[index].split("=").slice(1).join("=")
    : process.argv[index + 1];
  return inline?.trim() || undefined;
}

const dryRun = process.argv.includes("--dry-run");
const all = process.argv.includes("--all");
const shipUnsatisfied = process.argv.includes("--ship-unsatisfied");
const waitAfterShipMs = readFlagValue("--wait-after-ship-ms");
const appId =
  readFlagValue("--app-id") ?? readFlagValue("--appId");
const replicaId =
  readFlagValue("--replica-id") ?? readFlagValue("--replicaId");

if (!process.env.PAPR_API_KEY?.trim()) {
  console.warn(
    "[MigrationLedgerBackfill] PAPR_API_KEY not set — use npm run backfill:migration-ledgers:keychain",
  );
}

const summary = await runMigrationLedgerBackfill({
  dryRun,
  all,
  appId,
  replicaId,
  shipUnsatisfied,
  waitAfterShipMs: waitAfterShipMs
    ? Number.parseInt(waitAfterShipMs, 10)
    : undefined,
  apiKey: process.env.PAPR_API_KEY,
});

console.log(formatMigrationLedgerBackfillSummary(summary));

if (summary.failed > 0) {
  process.exit(1);
}

if (!dryRun && summary.applied > 0) {
  console.log(
    "\n[MigrationLedgerBackfill] Done. Restart gateway or wait for next flush — schema drift should clear.",
  );
}
