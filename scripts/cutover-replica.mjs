#!/usr/bin/env node
/**
 * Plan A Phase 3 — dry-run or execute legacy → replica cutover for registry DBs.
 *
 * Usage:
 *   node scripts/cutover-replica.mjs --dry-run
 *   node scripts/cutover-replica.mjs --db-id=db-abc123
 *   node scripts/cutover-replica.mjs --force-retry --db-id=db-abc123
 */

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvLocal, resolvePaprApiKey } from "./lib/testEnv.mjs";
import { readActiveWorkspace, applyReplicaE2eEnv } from "./lib/replicaE2eHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function parseArgs(argv) {
  let dryRun = false;
  let dbId;
  let forceRetry = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force-retry") {
      forceRetry = true;
    } else if (arg.startsWith("--db-id=")) {
      dbId = arg.slice("--db-id=".length).trim();
    }
  }
  return { dryRun, dbId, forceRetry };
}

async function main() {
  const { dryRun, dbId, forceRetry } = parseArgs(process.argv.slice(2));
  loadEnvLocal(repoRoot);

  try {
    await resolvePaprApiKey(repoRoot);
  } catch {
    console.warn(
      "[cutover-replica] No PAPR_API_KEY — remote Turso checks will be unavailable (offline classify).",
    );
  }

  try {
    const workspace = readActiveWorkspace();
    applyReplicaE2eEnv(workspace);
  } catch {
    /* optional — env may already be set for gateway-in-process runs */
  }

  process.env.PAPR_TURSO_REPLICA_SYNC ??= "replica-records";
  process.env.CLOUD_SYNC_ENABLED ??= "true";
  process.env.TURSO_SYNC_ENABLED ??= "true";

  const distOrchestrator = path.join(
    repoRoot,
    "dist/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js",
  );
  const distCandidates = path.join(
    repoRoot,
    "dist/gateway/services/tursoReplica/cutover/tursoReplicaCutoverCandidates.js",
  );
  const { runPendingReplicaCutovers, classifyPendingReplicaCutovers } =
    await import(pathToFileURL(distOrchestrator).href);
  const { listAppsLinkingRegistryDb, listLinkedLegacyCutoverCandidates } =
    await import(pathToFileURL(distCandidates).href);

  if (dryRun) {
    const classifications = await classifyPendingReplicaCutovers();
    const filtered = dbId
      ? classifications.filter((item) => item.dbId === dbId)
      : classifications;
    console.log(
      `\n=== Replica cutover dry-run (${filtered.length} linked legacy db(s)) ===\n`,
    );
    for (const item of filtered) {
      const records = await listLinkedLegacyCutoverCandidates({ dbId: item.dbId });
      const record = records[0];
      const appRefs = await listAppsLinkingRegistryDb(item.dbId, {
        ownerJobId: record?.ownerJobId,
      });
      const appLine =
        appRefs.length > 0
          ? appRefs.map((ref) => `${ref.appId.slice(0, 8)}… (${ref.alias})`).join(", ")
          : "(no app link — should not appear in linked-only batch)";
      console.log(`${item.dbId}: ${item.bucket}`);
      console.log(`  apps: ${appLine}`);
      console.log(`  ${item.reason}`);
      console.log(
        `  localTables=${item.snapshot.localTableCount} remoteTables=${item.snapshot.remoteTableCount} dirty=${item.snapshot.dirty}`,
      );
    }
    console.log("");
    return;
  }

  const batch = await runPendingReplicaCutovers({
    dbId,
    forceRetry,
    allowWithoutProductionAck: true,
  });

  console.log(`\n=== Replica cutover run ===`);
  console.log(
    `attempted=${batch.attempted} succeeded=${batch.succeeded} blocked=${batch.blocked} skipped=${batch.skipped}\n`,
  );
  for (const result of batch.results) {
    const status = result.ok
      ? "OK"
      : result.blocked
        ? "BLOCKED"
        : result.skipped
          ? "SKIP"
          : "FAIL";
    console.log(`${status} ${result.dbId} [${result.classification.bucket}]`);
    if (result.error) {
      console.log(`  ${result.error}`);
    }
  }
  console.log("");

  if (batch.blocked > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
