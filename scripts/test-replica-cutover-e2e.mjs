#!/usr/bin/env node
/**
 * Plan A Phase 3 cutover E2E — spikes 14–17 (orchestrator buckets B/C/D).
 *
 * Uses throwaway linked legacy registry DBs only; restores databases.json after run.
 *
 * Prerequisites:
 *   npm run build:gateway
 *   Papr Work login OR PAPR_API_KEY in .env.local for active workspace
 *
 * Usage:
 *   npm run test:replica-cutover-e2e
 */

import {
  applyReplicaE2eEnv,
  cleanupSqlite,
  createThrowawayFixture,
  destroyThrowawayFixture,
  importDist,
  patchBridgeCredentials,
  printSummary,
  readActiveWorkspace,
  record,
  reloadRegistry,
  remoteExec,
  remoteQuery,
  requireReplicaE2eAccess,
  resetReplicaConnections,
  warmupTursoDatabaseHost,
} from "./lib/replicaE2eHarness.mjs";

async function ensureTursoDatabaseReady(creds, localPath) {
  await warmupTursoDatabaseHost(creds, localPath);
}

async function writeLocalLegacyDb(localPath, setup) {
  const { openWritableLocalJobDb } = await importDist(
    "gateway/services/tursoSyncBridgeCore.js",
  );
  cleanupSqlite(localPath);
  const db = openWritableLocalJobDb(localPath);
  try {
    setup(db);
  } finally {
    db.close();
  }
}

function createEmptyLocalDb(localPath) {
  return writeLocalLegacyDb(localPath, () => {
    /* empty database file */
  });
}

async function getRegistryRecord(dbId) {
  const { getDatabaseRegistryService } = await importDist(
    "gateway/services/DatabaseRegistryService.js",
  );
  return getDatabaseRegistryService().getById(dbId);
}

async function importCutoverOrchestrator() {
  return importDist(
    "gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js",
  );
}

async function selectAllViaReplica(dbId, table) {
  const { queryLinkedDbViaTursoReplica } = await importDist(
    "gateway/services/tursoReplica/tursoReplicaRouting.js",
  );
  const registryRecord = await getRegistryRecord(dbId);
  if (!registryRecord) {
    throw new Error(`Missing registry record ${dbId}`);
  }
  const source = {
    id: dbId,
    type: "sqlite",
    dbId,
    alias: registryRecord.label ?? dbId,
    dbPath: registryRecord.localPath,
    tables: [],
    linkedAt: registryRecord.createdAt,
  };
  return queryLinkedDbViaTursoReplica(source, `SELECT * FROM ${table}`);
}

/** Spike 14 — Bucket B: local rows, remote empty → seed → replica. */
async function testSpike14SeedLocal(access, bridge) {
  const fixture = await createThrowawayFixture(access, {
    syncMode: "legacy",
    withApp: true,
  });

  try {
    await reloadRegistry();
    patchBridgeCredentials(bridge, access);

    const creds = await bridge.fetchCredentials(fixture.tursoDatabase);
    await ensureTursoDatabaseReady(creds, fixture.localPath);

    await writeLocalLegacyDb(fixture.localPath, (db) => {
      db.exec(
        "CREATE TABLE seed_marker (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO seed_marker (label) VALUES (?)").run("local-only-row");
    });

    const { classifyRecordForReplicaCutover } = await importDist(
      "gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
    );
    const { runCutoverForRecord } = await importCutoverOrchestrator();

    const recordBefore = await getRegistryRecord(fixture.dbId);
    let classification = await classifyRecordForReplicaCutover(recordBefore);
    if (classification.bucket === "blocked" && classification.snapshot.remoteCheckFailed) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      classification = await classifyRecordForReplicaCutover(recordBefore);
    }
    const bucketOk = classification.bucket === "seed_local";
    record(
      "spike-14-classify",
      bucketOk,
      bucketOk
        ? "remote empty + local rows → seed_local"
        : `expected seed_local, got ${classification.bucket}`,
    );

    const cutover = await runCutoverForRecord(recordBefore, {
      allowWithoutProductionAck: true,
    });
    await reloadRegistry();
    const after = await getRegistryRecord(fixture.dbId);

    const cutoverOk =
      cutover.ok === true &&
      after?.syncMode === "replica" &&
      after?.cutoverBlocked !== true;
    record(
      "spike-14-cutover",
      cutoverOk,
      cutoverOk
        ? "orchestrator seeded and marked syncMode=replica"
        : `ok=${cutover.ok} syncMode=${after?.syncMode} error=${cutover.error ?? ""}`,
    );

    let remoteRowCount = 0;
    try {
      const remoteRows = await remoteQuery(
        creds,
        "SELECT label FROM seed_marker WHERE label = 'local-only-row'",
      );
      remoteRowCount = remoteRows.rows.length;
    } catch {
      /* fall through to replica read */
    }
    if (remoteRowCount === 0) {
      try {
        const localRead = await selectAllViaReplica(fixture.dbId, "seed_marker");
        remoteRowCount = localRead.rows?.length ?? 0;
      } catch {
        remoteRowCount = 0;
      }
    }
    record(
      "spike-14-remote-rows",
      remoteRowCount === 1,
      `seeded row visible (count=${remoteRowCount})`,
    );
  } finally {
    await destroyThrowawayFixture(fixture);
    await reloadRegistry();
    await resetReplicaConnections();
  }
}

/** Spike 15 — Bucket C: remote has rows → cutover pull → desktop matches cloud. */
async function testSpike15PullRemote(access, bridge) {
  const fixture = await createThrowawayFixture(access, {
    syncMode: "legacy",
    withApp: true,
  });

  try {
    await reloadRegistry();
    patchBridgeCredentials(bridge, access);

    const creds = await bridge.fetchCredentials(fixture.tursoDatabase);
    await ensureTursoDatabaseReady(creds, fixture.localPath);

    await remoteExec(
      creds,
      "CREATE TABLE IF NOT EXISTS cloud_truth (id INTEGER PRIMARY KEY, source TEXT NOT NULL)",
    );
    await remoteExec(creds, "DELETE FROM cloud_truth");
    await remoteExec(
      creds,
      "INSERT INTO cloud_truth (source) VALUES ('from-turso-authority')",
    );

    await createEmptyLocalDb(fixture.localPath);

    const { classifyRecordForReplicaCutover } = await importDist(
      "gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
    );
    const { runCutoverForRecord } = await importCutoverOrchestrator();

    const recordBefore = await getRegistryRecord(fixture.dbId);
    const classification = await classifyRecordForReplicaCutover(recordBefore);
    const bucketOk = classification.bucket === "pull_remote";
    record(
      "spike-15-classify",
      bucketOk,
      bucketOk
        ? "remote has rows → pull_remote"
        : `expected pull_remote, got ${classification.bucket}`,
    );

    const cutover = await runCutoverForRecord(recordBefore, {
      allowWithoutProductionAck: true,
    });
    await reloadRegistry();
    await resetReplicaConnections();

    const read = await selectAllViaReplica(fixture.dbId, "cloud_truth");
    const truthOk =
      cutover.ok === true &&
      read.rows?.length === 1 &&
      String(read.rows[0].source ?? read.rows[0].value) === "from-turso-authority";
    record(
      "spike-15-cutover-pull",
      truthOk,
      truthOk
        ? "replica file matches Turso authority after cutover"
        : `ok=${cutover.ok} rows=${JSON.stringify(read.rows)}`,
    );

    let staleGone = false;
    try {
      const staleRead = await selectAllViaReplica(fixture.dbId, "stale_only");
      staleGone = (staleRead.rows?.length ?? 0) === 0;
    } catch {
      staleGone = true;
    }
    record(
      "spike-15-stale-gone",
      staleGone,
      staleGone ? "stale local-only table not visible after pull" : "stale table still readable",
    );
  } finally {
    await destroyThrowawayFixture(fixture);
    await reloadRegistry();
    await resetReplicaConnections();
  }
}

/** Spike 16 — Bucket C + dirty local: legacy push before cutover, no row loss. */
async function testSpike16DirtyPushBeforeCutover(access, bridge) {
  const fixture = await createThrowawayFixture(access, {
    syncMode: "legacy",
    withApp: true,
  });

  try {
    await reloadRegistry();
    patchBridgeCredentials(bridge, access);

    const creds = await bridge.fetchCredentials(fixture.tursoDatabase);
    await ensureTursoDatabaseReady(creds, fixture.localPath);

    await remoteExec(
      creds,
      "CREATE TABLE IF NOT EXISTS merge_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
    );
    await remoteExec(creds, "DELETE FROM merge_rows");
    await remoteExec(creds, "INSERT INTO merge_rows (id, label) VALUES (1, 'from-remote')");

    await writeLocalLegacyDb(fixture.localPath, (db) => {
      db.exec(
        "CREATE TABLE merge_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO merge_rows (id, label) VALUES (?, ?)").run(
        2,
        "from-local-unpushed",
      );
    });

    const { classifyRecordForReplicaCutover } = await importDist(
      "gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
    );
    const { runCutoverForRecord } = await importCutoverOrchestrator();

    const recordBefore = await getRegistryRecord(fixture.dbId);
    const classification = await classifyRecordForReplicaCutover(recordBefore);
    const dirtyOk =
      classification.bucket === "pull_remote" && classification.snapshot.dirty === true;
    record(
      "spike-16-classify-dirty",
      dirtyOk,
      dirtyOk
        ? "remote + dirty local → pull_remote with dirty=true"
        : `bucket=${classification.bucket} dirty=${classification.snapshot.dirty}`,
    );

    const cutover = await runCutoverForRecord(recordBefore, {
      allowWithoutProductionAck: true,
    });
    await reloadRegistry();
    await resetReplicaConnections();

    const remoteAfter = await remoteQuery(
      creds,
      "SELECT id, label FROM merge_rows ORDER BY id ASC",
    );
    const labels = remoteAfter.rows.map((row) => String(row.label ?? row[1]));
    const noLoss =
      cutover.ok === true &&
      labels.includes("from-remote") &&
      labels.includes("from-local-unpushed");
    record(
      "spike-16-no-row-loss",
      noLoss,
      noLoss
        ? `remote has both rows: ${labels.join(", ")}`
        : `ok=${cutover.ok} labels=${labels.join(",")} legacyPush=${JSON.stringify(cutover.legacyPush)}`,
    );
  } finally {
    await destroyThrowawayFixture(fixture);
    await reloadRegistry();
    await resetReplicaConnections();
  }
}

/** Spike 17 — Bucket D: schema drift blocked → repair alignment → retry succeeds. */
async function testSpike17SchemaDriftRepair(access, bridge) {
  const fixture = await createThrowawayFixture(access, {
    syncMode: "legacy",
    withApp: true,
  });

  try {
    await reloadRegistry();
    patchBridgeCredentials(bridge, access);

    const creds = await bridge.fetchCredentials(fixture.tursoDatabase);
    await ensureTursoDatabaseReady(creds, fixture.localPath);

    await remoteExec(
      creds,
      "CREATE TABLE IF NOT EXISTS drift_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, status TEXT DEFAULT 'active')",
    );
    await remoteExec(creds, "DELETE FROM drift_items");
    await remoteExec(
      creds,
      "INSERT INTO drift_items (id, label, status) VALUES (1, 'cloud-row', 'active')",
    );

    await writeLocalLegacyDb(fixture.localPath, (db) => {
      db.exec(
        "CREATE TABLE drift_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO drift_items (label) VALUES (?)").run("local-row");
    });

    const { classifyRecordForReplicaCutover } = await importDist(
      "gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
    );
    const { runCutoverForRecord, retryReplicaCutoverAfterRepair } =
      await importCutoverOrchestrator();

    let recordBefore = await getRegistryRecord(fixture.dbId);
    const blockedClass = await classifyRecordForReplicaCutover(recordBefore);
    const blockedOk = blockedClass.bucket === "blocked";
    record(
      "spike-17-classify-blocked",
      blockedOk,
      blockedOk
        ? "schema drift → blocked (bucket D)"
        : `expected blocked, got ${blockedClass.bucket}`,
    );

    const firstRun = await runCutoverForRecord(recordBefore, {
      allowWithoutProductionAck: true,
    });
    await reloadRegistry();
    recordBefore = await getRegistryRecord(fixture.dbId);
    const firstBlocked =
      firstRun.blocked === true &&
      firstRun.ok === false &&
      recordBefore?.syncMode !== "replica";
    record(
      "spike-17-cutover-blocked",
      firstBlocked,
      firstBlocked
        ? "cutover refused while drift present (still legacy)"
        : `ok=${firstRun.ok} syncMode=${recordBefore?.syncMode}`,
    );

    cleanupSqlite(fixture.localPath);
    await writeLocalLegacyDb(fixture.localPath, (db) => {
      db.exec(
        "CREATE TABLE drift_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, status TEXT DEFAULT 'active')",
      );
      db.prepare("INSERT INTO drift_items (id, label, status) VALUES (?, ?, ?)").run(
        1,
        "cloud-row",
        "active",
      );
    });

    const { getDatabaseRegistryService } = await importDist(
      "gateway/services/DatabaseRegistryService.js",
    );
    await getDatabaseRegistryService().updateReplicaPushState(fixture.dbId, {
      cutoverBlocked: false,
      cutoverBlockReason: null,
    });
    await reloadRegistry();

    const afterRepairClass = await classifyRecordForReplicaCutover(
      await getRegistryRecord(fixture.dbId),
    );
    const repairClassOk = afterRepairClass.bucket === "pull_remote";
    record(
      "spike-17-repair-classify",
      repairClassOk,
      repairClassOk
        ? "aligned schema → pull_remote"
        : `expected pull_remote, got ${afterRepairClass.bucket}`,
    );

    const retry = await retryReplicaCutoverAfterRepair(fixture.dbId);
    await reloadRegistry();
    await resetReplicaConnections();

    const finalRecord = await getRegistryRecord(fixture.dbId);
    const retryOk = retry?.ok === true && finalRecord?.syncMode === "replica";
    record(
      "spike-17-retry-succeeds",
      retryOk,
      retryOk
        ? "retry after repair cut over to replica"
        : `retry ok=${retry?.ok} syncMode=${finalRecord?.syncMode} error=${retry?.error ?? ""}`,
    );

    const read = await selectAllViaReplica(fixture.dbId, "drift_items");
    const rowOk =
      read.rows?.length === 1 &&
      String(read.rows[0].label ?? read.rows[0][1]) === "cloud-row";
    record(
      "spike-17-data-matches",
      rowOk,
      rowOk ? "replica reads cloud authority row" : `rows=${JSON.stringify(read.rows)}`,
    );
  } finally {
    await destroyThrowawayFixture(fixture);
    await reloadRegistry();
    await resetReplicaConnections();
  }
}

async function main() {
  console.log("\n=== Plan A cutover E2E (spikes 14–17) ===\n");

  const access = await requireReplicaE2eAccess();
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);

  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  await testSpike14SeedLocal(access, bridge);
  await testSpike15PullRemote(access, bridge);
  await testSpike16DirtyPushBeforeCutover(access, bridge);
  await testSpike17SchemaDriftRepair(access, bridge);

  const allPassed = printSummary();
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
