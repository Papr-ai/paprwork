#!/usr/bin/env node
/**
 * Canonical Plan A E2E: local replica migration → DML → push → verify Turso cloud primary.
 *
 * This is the path agents must use (papr_db_apply_migration, not papr_db_exec DDL).
 * Verifies schema + rows + schema_migrations ledger on Turso after push.
 *
 * Prerequisites:
 *   npm run build:gateway
 *   Papr login (keychain) OR PAPR_API_KEY in .env.local for active workspace
 *   PAPR_TURSO_REPLICA_SYNC=replica-records (recommended in .env.local)
 *
 * Usage:
 *   npm run test:replica-migration-cloud-e2e
 */

import {
  applyReplicaE2eEnv,
  createThrowawayFixture,
  destroyThrowawayFixture,
  fetchTursoCredentials,
  importDist,
  patchBridgeCredentials,
  printSummary,
  provisionTursoReplica,
  readActiveWorkspace,
  record,
  reloadRegistry,
  remoteQuery,
  requireReplicaE2eAccess,
  resetReplicaConnections,
  writeMigration,
} from "./lib/replicaE2eHarness.mjs";

const PUSH_TIMEOUT_MS = 90_000;
const SYNC_SETTLE_MS = 15_000;
const SYNC_POLL_MS = 500;

async function withTimeout(promise, label, ms = PUSH_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSyncSettled(paprDbSyncStatus, dbId) {
  const deadline = Date.now() + SYNC_SETTLE_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await paprDbSyncStatus({ dbId });
    if (
      last.syncMode === "replica" &&
      last.online === true &&
      last.pendingPush === false &&
      !last.lastPushError &&
      !last.migrationConflict
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
  }
  return last;
}

async function main() {
  console.log("\n=== Plan A — Migration → Push → Cloud verify E2E ===\n");

  const access = await requireReplicaE2eAccess();
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);
  console.log(`Workspace: ${workspace.paprHome}\n`);

  const fixture = await createThrowawayFixture(access, { withApp: false });
  console.log(`Throwaway DB: ${fixture.dbId} (${fixture.slug})\n`);

  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const creds = await fetchTursoCredentials(access, fixture.tursoDatabase);
  await provisionTursoReplica(creds, `${fixture.localPath}.e2e-provision`);

  const { dbId, migrationRoot } = fixture;
  const migrationId = "0001_migration_cloud_e2e";
  const markerTable = "migration_cloud_e2e";
  const markerRow = `e2e-${Date.now().toString(36)}`;

  try {
    await reloadRegistry();
    await resetReplicaConnections();

    const { paprDbApplyMigration, paprDbExec, paprDbPush, paprDbSyncStatus } =
      await importDist("gateway/services/tursoReplica/PaprDbService.js");

    await writeMigration(
      migrationRoot,
      `${migrationId}.sql`,
      `CREATE TABLE IF NOT EXISTS ${markerTable} (
  id INTEGER PRIMARY KEY,
  note TEXT NOT NULL,
  description TEXT
);`,
    );

    const migration = await withTimeout(
      paprDbApplyMigration({ dbId, migrationId }),
      "papr_db_apply_migration",
    );
    record(
      "migration-local-replica",
      migration.applied === true && migration.backend === "turso-replica",
      `applied=${migration.applied} backend=${migration.backend} pendingPush=${migration.pendingPush}`,
    );

    const write = await paprDbExec({
      dbId,
      sql: `INSERT INTO ${markerTable} (note, description) VALUES (?, ?)`,
      params: [markerRow, "migration-cloud-e2e"],
    });
    record(
      "dml-local-replica",
      write.backend === "turso-replica" && write.changes === 1,
      `backend=${write.backend} changes=${write.changes} pendingPush=${write.pendingPush}`,
    );

    const push = await withTimeout(paprDbPush({ dbId }), "papr_db_push");
    record(
      "push-local-to-cloud",
      push.ok === true,
      push.ok ? "ok" : push.error ?? "failed",
    );

    const remoteTable = await remoteQuery(
      creds,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${markerTable}'`,
    );
    record(
      "cloud-table-exists",
      remoteTable.rows.length === 1,
      `tables=${remoteTable.rows.length}`,
    );

    const remoteCols = await remoteQuery(creds, `PRAGMA table_info(${markerTable})`);
    const colNames = remoteCols.rows.map((row) => String(row.name ?? row[1]));
    record(
      "cloud-schema-columns",
      colNames.includes("note") && colNames.includes("description"),
      `columns=${colNames.join(",")}`,
    );

    const remoteRow = await remoteQuery(
      creds,
      `SELECT note, description FROM ${markerTable} WHERE note = '${markerRow.replace(/'/g, "''")}'`,
    );
    record(
      "cloud-row-visible",
      remoteRow.rows.length === 1,
      `rows=${remoteRow.rows.length}`,
    );

    const remoteLedger = await remoteQuery(
      creds,
      `SELECT id FROM schema_migrations WHERE id = '${migrationId}'`,
    );
    record(
      "cloud-migration-ledger",
      remoteLedger.rows.length === 1,
      `ledgerRows=${remoteLedger.rows.length}`,
    );

    const status = await waitForSyncSettled(paprDbSyncStatus, dbId);
    record(
      "sync-status-settled",
      status?.pendingPush === false && !status?.lastPushError,
      status
        ? `pendingPush=${status.pendingPush} pendingOps=${status.pendingOps} lastPushError=${status.lastPushError ?? "none"}`
        : "no status",
    );

    // Second push should be idempotent (no conflict, no error)
    const secondPush = await withTimeout(paprDbPush({ dbId }), "papr_db_push (idempotent)");
    record(
      "push-idempotent",
      secondPush.ok === true,
      secondPush.ok ? "ok" : secondPush.error ?? "failed",
    );
  } finally {
    await resetReplicaConnections();
    await destroyThrowawayFixture(fixture);
    console.log("\nRestored workspace fixtures");
  }

  const allPass = printSummary();
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(
    "MIGRATION_CLOUD_E2E_FATAL:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
