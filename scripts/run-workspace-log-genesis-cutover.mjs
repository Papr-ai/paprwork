#!/usr/bin/env node
/**
 * Run idempotent workspace-log genesis cutover for all Turso-linked replicas.
 *
 * Usage:
 *   npm run genesis:workspace-log
 *   node --import tsx scripts/run-workspace-log-genesis-cutover.mjs
 */

import { runWorkspaceLogGenesisCutoverForAllLinkedSources } from "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js";

const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();

console.log(
  `[GenesisCutover] attempted=${summary.attempted} completed=${summary.completed} skipped=${summary.skipped} failed=${summary.failed}`,
);

for (const detail of summary.details) {
  const err = detail.error ? ` — ${detail.error}` : "";
  console.log(`  ${detail.status} ${detail.replicaId} (${detail.dbPath})${err}`);
}

if (summary.failed > 0) {
  process.exit(1);
}
