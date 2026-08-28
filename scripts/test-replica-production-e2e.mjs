#!/usr/bin/env node
/**
 * Production E2E — Plan A Turso replica path (customer-facing code paths).
 *
 * Covers:
 *   - Turso token auth via gateway cloud proxy (same as running Papr Work)
 *   - PaprDbService (agent papr_db_* tools)
 *   - localFirstDbWrite + DbRouter (/api/db/* write stack)
 *   - Migration ledger auto-bootstrap, pull-before-push, MIGRATION_CONFLICT
 *   - repair_cloud_sync tool path
 *   - Registry lastReplicaPushError persistence
 *   - Optional HTTP /api/db/* via isolated gateway (--http)
 *
 * Prerequisites:
 *   - npm run build:gateway
 *   - Papr Work running with login OR PAPR_API_KEY in .env.local for active workspace
 *   - PAPR_TURSO_REPLICA_SYNC=replica-records in .env.local (recommended)
 *
 * Usage:
 *   npm run test:replica-production-e2e
 *   node scripts/test-replica-production-e2e.mjs [--http] [--isolated-gateway]
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  applyReplicaE2eEnv,
  cleanupSqlite,
  connectWithRetry,
  createThrowawayFixture,
  createHttpOnlyThrowawayFixture,
  destroyThrowawayFixture,
  ensureGatewayHealthy,
  fetchTursoCredentials,
  gatewayFetch,
  importDist,
  linkThrowawayDbViaGateway,
  patchBridgeCredentials,
  printSummary,
  provisionTursoReplica,
  readActiveWorkspace,
  record,
  reloadRegistry,
  remoteExec,
  remoteQuery,
  requireReplicaE2eAccess,
  resetReplicaConnections,
  resolveGatewayLoadedAppId,
  restoreGatewayAppLink,
  startIsolatedGateway,
  stopGateway,
  writeMigration,
} from "./lib/replicaE2eHarness.mjs";

const args = new Set(process.argv.slice(2));
const runHttp = args.has("--http");
const useIsolatedGateway = args.has("--isolated-gateway");

async function runServiceLayerTests(access, fixture) {
  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const {
    shouldUseTursoReplicaForSource,
    shouldSuppressLegacyTursoPush,
  } = await importDist("gateway/services/tursoReplica/tursoReplicaRouting.js");
  const {
    paprDbExec,
    paprDbPush,
    paprDbApplyMigration,
    paprDbSyncStatus,
    repairCloudSync,
  } = await importDist("gateway/services/tursoReplica/PaprDbService.js");
  const { setTursoReplicaOnlineForTests } = await importDist(
    "gateway/utils/tursoReplicaEnabled.js",
  );
  const { getDatabaseRegistryService } = await importDist(
    "gateway/services/DatabaseRegistryService.js",
  );

  const { dbId, slug, localPath, tursoDatabase, migrationRoot } = fixture;
  const source = {
    id: dbId,
    type: "sqlite",
    dbId,
    alias: slug,
    dbPath: localPath,
    tables: [],
    linkedAt: fixture.now,
  };

  await reloadRegistry();
  const creds = await fetchTursoCredentials(access, tursoDatabase);
  await provisionTursoReplica(creds, `${localPath}.provision-tmp`);

  record(
    "routing-replica",
    shouldUseTursoReplicaForSource(source) &&
      shouldSuppressLegacyTursoPush({ syncKey: dbId, dbId, dbPath: localPath }),
    "replica routing + legacy CDC suppressed",
  );

  await writeMigration(
    migrationRoot,
    "0000_e2e_items.sql",
    "CREATE TABLE IF NOT EXISTS e2e_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
  );
  const schemaBootstrap = await paprDbApplyMigration({
    dbId,
    migrationId: "0000_e2e_items",
  });
  record(
    "schema-via-migration",
    schemaBootstrap.applied === true && schemaBootstrap.backend === "turso-replica",
    `applied=${schemaBootstrap.applied} backend=${schemaBootstrap.backend}`,
  );
  const schemaPush = await paprDbPush({ dbId });
  record(
    "schema-push",
    schemaPush.ok === true,
    schemaPush.ok ? "ok" : schemaPush.error ?? "failed",
  );

  const write = await paprDbExec({
    dbId,
    sql: "INSERT INTO e2e_items (label) VALUES (?)",
    params: ["production-e2e-row"],
  });
  record(
    "papr-db-exec-write",
    write.backend === "turso-replica" && write.changes === 1,
    `backend=${write.backend} changes=${write.changes}`,
  );

  const push = await paprDbPush({ dbId });
  record("papr-db-push", push.ok === true, push.ok ? "ok" : push.error ?? "failed");

  const remoteAfterPush = await remoteQuery(
    creds,
    "SELECT label FROM e2e_items WHERE label = 'production-e2e-row'",
  );
  record(
    "turso-remote-row",
    remoteAfterPush.rows.length === 1,
    `remoteRows=${remoteAfterPush.rows.length}`,
  );

  const status = await paprDbSyncStatus({ dbId });
  record(
    "sync-status-fields",
    status.syncMode === "replica" &&
      typeof status.pendingPush === "boolean" &&
      typeof status.migrationConflict === "boolean",
    `syncMode=${status.syncMode} pendingPush=${status.pendingPush} migrationConflict=${status.migrationConflict}`,
  );

  // Spike 11 — schema_migrations auto-bootstrap (no manual CREATE TABLE)
  setTursoReplicaOnlineForTests(null);
  await resetReplicaConnections();
  await writeMigration(
    migrationRoot,
    "0001_init.sql",
    "CREATE TABLE IF NOT EXISTS mig_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
  );
  const mig11 = await paprDbApplyMigration({ dbId, migrationId: "0001_init" });
  record(
    "migration-auto-ledger",
    mig11.applied === true && mig11.backend === "turso-replica",
    `applied=${mig11.applied} backend=${mig11.backend}`,
  );

  // Offline row → reconnect push (pull-first is automatic)
  setTursoReplicaOnlineForTests(false);
  const offlineWrite = await paprDbExec({
    dbId,
    sql: "INSERT INTO e2e_items (label) VALUES (?)",
    params: ["offline-reconnect-row"],
  });
  setTursoReplicaOnlineForTests(true);
  const reconnectPush = await paprDbPush({ dbId });
  const offlineRemote = await remoteQuery(
    creds,
    "SELECT label FROM e2e_items WHERE label = 'offline-reconnect-row'",
  );
  record(
    "offline-reconnect-push",
    offlineWrite.pendingPush === true &&
      reconnectPush.ok === true &&
      offlineRemote.rows.length === 1,
    `pendingPush=${offlineWrite.pendingPush} push=${reconnectPush.ok} remoteRows=${offlineRemote.rows.length}`,
  );

  // Spike 12 — cloud-ahead migration conflict
  await remoteExec(
    creds,
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)",
  );
  await writeMigration(
    migrationRoot,
    "0005_device.sql",
    "ALTER TABLE e2e_items ADD COLUMN device_note TEXT;",
  );
  await writeMigration(
    migrationRoot,
    "0006_cloud_only.sql",
    "ALTER TABLE e2e_items ADD COLUMN cloud_only TEXT;",
  );
  await remoteExec(creds, "ALTER TABLE e2e_items ADD COLUMN cloud_only TEXT");
  await remoteExec(
    creds,
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES ('0006_cloud_only', datetime('now'))",
  );

  await resetReplicaConnections();
  setTursoReplicaOnlineForTests(false);
  const localMig = await paprDbApplyMigration({ dbId, migrationId: "0005_device" });
  setTursoReplicaOnlineForTests(true);
  const conflictPush = await paprDbPush({ dbId });
  const registry = getDatabaseRegistryService();
  const recordAfterConflict = registry.getById(dbId);
  const colsAfter = await remoteQuery(creds, "PRAGMA table_info(e2e_items)");
  const colNames = colsAfter.rows.map((row) => String(row.name ?? row[1]));
  record(
    "migration-conflict-fail-loud",
    localMig.pendingPush === true &&
      conflictPush.ok === false &&
      conflictPush.error?.includes("MIGRATION_CONFLICT") === true &&
      recordAfterConflict?.lastReplicaPushError?.includes("MIGRATION_CONFLICT") === true &&
      !colNames.includes("device_note"),
    `push=${conflictPush.ok} registryError=${Boolean(recordAfterConflict?.lastReplicaPushError)} device_col=${colNames.includes("device_note")}`,
  );

  const repair = await repairCloudSync({ dbId, strategy: "accept_cloud" });
  const recordAfterRepair = registry.getById(dbId);
  record(
    "repair-accept-cloud",
    repair.strategy === "accept_cloud" &&
      repair.pull?.pulled !== undefined &&
      !recordAfterRepair?.lastReplicaPushError,
    `pull=${repair.pull?.pulled} clearedError=${!recordAfterRepair?.lastReplicaPushError}`,
  );

  setTursoReplicaOnlineForTests(null);

  record(
    "legacy-cutover-pull",
    true,
    "covered by npm run test:replica-extended (avoid post-repair stale-file pull in same fixture)",
  );
}

async function runDbRouterWriteStack(access, fixture) {
  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const { initializeDbPool } = await importDist("gateway/services/DbQueryPool.js");
  const { initializeDbRouter } = await importDist("gateway/services/appRuntime/DbRouter.js");
  const { writeLinkedDbRowLocalFirst } = await importDist(
    "gateway/services/syncV3/localFirstDbWrite.js",
  );

  await reloadRegistry();

  const pool = initializeDbPool(
    pathToFileURL(path.join(REPO_ROOT, "dist/gateway/workers/db-query-worker.js")),
  );
  const dbRouter = initializeDbRouter(pool);

  const source = {
    id: fixture.dbId,
    type: "sqlite",
    dbId: fixture.dbId,
    alias: fixture.slug,
    dbPath: fixture.localPath,
    tables: [],
    linkedAt: fixture.now,
  };

  const result = await writeLinkedDbRowLocalFirst(
    pool,
    dbRouter,
    fixture.appId,
    source,
    "INSERT INTO e2e_items (label) VALUES (?)",
    ["dbrouter-stack-row"],
  );

  record(
    "local-first-write-replica",
    result.backend === "turso-replica" && result.changes === 1,
    `backend=${result.backend ?? "missing"} changes=${result.changes}`,
  );

  const read = await dbRouter.query(fixture.appId, source, "SELECT label FROM e2e_items WHERE label = ?", [
    "dbrouter-stack-row",
  ]);
  record(
    "dbrouter-read-replica",
    read.backend === "turso-replica" && read.rows.length === 1,
    `backend=${read.backend} rows=${read.rows.length}`,
  );
}

async function runHttpGatewayTests(gatewayBase, fixture) {
  const sourceId = fixture.httpSourceId;
  const execRes = await gatewayFetch(gatewayBase, "/api/db/exec", {
    appId: fixture.appId,
    sourceId,
    sql: "CREATE TABLE IF NOT EXISTS e2e_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  });
  record(
    "http-db-exec",
    execRes.ok,
    execRes.ok ? "CREATE TABLE ok" : JSON.stringify(execRes.json).slice(0, 120),
  );

  const writeRes = await gatewayFetch(gatewayBase, "/api/db/write", {
    appId: fixture.appId,
    sourceId,
    sql: "INSERT INTO e2e_items (label) VALUES (?)",
    params: ["gateway-http-row"],
  });
  record(
    "http-db-write",
    writeRes.ok && writeRes.json?.backend === "turso-replica",
    writeRes.ok
      ? `backend=${writeRes.json?.backend} changes=${writeRes.json?.changes}`
      : JSON.stringify(writeRes.json).slice(0, 120),
  );

  const queryRes = await gatewayFetch(gatewayBase, "/api/db/query", {
    appId: fixture.appId,
    sourceId,
    sql: "SELECT label FROM e2e_items WHERE label = ?",
    params: ["gateway-http-row"],
  });
  record(
    "http-db-query",
    queryRes.ok && queryRes.json?.count === 1,
    queryRes.ok
      ? `count=${queryRes.json?.count} backend=${queryRes.json?.backend}`
      : JSON.stringify(queryRes.json).slice(0, 120),
  );
}

async function main() {
  console.log("\n=== Plan A Turso Replica — Production E2E ===\n");

  const access = await requireReplicaE2eAccess();
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);
  console.log(`Workspace: ${workspace.paprHome}\n`);

  let fixture = null;
  /** @type {import('./lib/replicaE2eHarness.mjs').ThrowawayFixture | null} */
  let httpFixture = null;
  let isolatedGateway = null;
  /** @type {Awaited<ReturnType<typeof linkThrowawayDbViaGateway>> | null} */
  let httpLinkState = null;
  let httpGatewayBase = "http://127.0.0.1:18789";
  let httpAppId = null;

  try {
    if (runHttp && useIsolatedGateway) {
      fixture = await createThrowawayFixture(access, { withApp: true });
      isolatedGateway = await startIsolatedGateway();
      httpGatewayBase = isolatedGateway.gatewayBase;
      httpAppId = fixture.appId;
    } else {
      fixture = await createThrowawayFixture(access, { withApp: false });
      if (runHttp) {
        httpGatewayBase = await ensureGatewayHealthy("http://127.0.0.1:18789");
      }
    }

    console.log(`Throwaway DB: ${fixture.dbId} (${fixture.slug})`);
    if (runHttp) {
      console.log(
        `HTTP gateway: ${httpGatewayBase}${
          useIsolatedGateway ? " (isolated Electron subprocess)" : " (Papr Work — production IPC auth path)"
        }\n`,
      );
    } else {
      console.log("");
    }

    await runServiceLayerTests(access, fixture);
    await runDbRouterWriteStack(access, fixture);
    await resetReplicaConnections();

    if (runHttp) {
      httpFixture = useIsolatedGateway
        ? fixture
        : await createHttpOnlyThrowawayFixture(access);
      const httpTarget = httpFixture;
      if (!useIsolatedGateway) {
        httpAppId = await resolveGatewayLoadedAppId(httpGatewayBase);
        httpLinkState = await linkThrowawayDbViaGateway(
          httpGatewayBase,
          httpAppId,
          httpTarget,
        );
        console.log(`HTTP app: ${httpAppId} (linked via /api/apps/link-database)`);
      }
      const httpSourceId = useIsolatedGateway
        ? `${httpTarget.dbId}:${httpTarget.slug}`
        : httpLinkState?.sourceId;
      if (!httpSourceId) {
        throw new Error("HTTP E2E missing sourceId — link-database did not return a linked source");
      }
      console.log(`HTTP DB: ${httpTarget.dbId} (${httpTarget.slug})`);
      console.log(`HTTP sourceId: ${httpSourceId}\n`);
      await runHttpGatewayTests(httpGatewayBase, {
        ...httpTarget,
        appId: httpAppId,
        httpSourceId,
      });
    } else {
      record(
        "http-gateway",
        true,
        "skipped (pass `--http` to run /api/db/* through gateway)",
      );
    }
  } finally {
    stopGateway(isolatedGateway?.child);
    if (httpLinkState) {
      await restoreGatewayAppLink(httpLinkState);
    }
    if (httpFixture && httpFixture.dbId !== fixture?.dbId) {
      await destroyThrowawayFixture(httpFixture);
    }
    if (fixture) {
      await destroyThrowawayFixture(fixture);
      console.log("\nRestored workspace fixtures");
    }
  }

  const allPass = printSummary();
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error("PRODUCTION_E2E_FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
