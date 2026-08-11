#!/usr/bin/env node
/**
 * Integration test — Turso sync overlap (no double push, db-changed pull, registry scope).
 *
 * NOT full cloud E2E: calls syncTursoFromCloudDbChanged directly instead of waiting for
 * memory server heartbeat pendingTursoDbChanges. Uses real Turso + temp PAPR_HOME.
 *
 * Scenarios O1–O9 from docs/SYNC_EVENT_DRIVEN_PLAN.md
 *
 * Usage:
 *   npm run test:turso-sync-overlap-e2e
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvLocal, requirePaprApiKey } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvLocal();
const API_KEY = requirePaprApiKey();

function parsePaprApiKeyScope(apiKey) {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

const keyScope = parsePaprApiKeyScope(API_KEY);
if (keyScope) {
  process.env.PAPR_ORG_ID = keyScope.organizationId;
  process.env.PAPR_NAMESPACE_ID = keyScope.namespaceId;
}

process.env.PAPR_MEMORY_SERVER_URL = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
).replace(/\/$/, "");
process.env.PAPR_API_KEY = API_KEY;
process.env.NODE_ENV = "development";
process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
process.env.TURSO_PUSH_DEBOUNCE_MS = process.env.TURSO_PUSH_DEBOUNCE_MS ?? "800";

/** Chokidar awaitWriteFinish stability in TursoLinkedDbWatcher. */
const WATCHER_STABILITY_MS = 2_100;

function log(msg) {
  console.log(msg);
}

function fail(label, detail) {
  console.error(`❌ FAIL [${label}]:`, detail);
  process.exit(1);
}

function cleanupDb(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadModule(relativePath) {
  return import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services", relativePath)).href
  );
}

function seedItemsTable(dbPath, label) {
  cleanupDb(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO items (label) VALUES (?)").run(label);
  db.close();
}

function readLabels(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT label FROM items ORDER BY id")
      .all()
      .map((row) => row.label);
  } finally {
    db.close();
  }
}

async function drainPushQueue() {
  const { resetTursoPushQueueForTests } = await loadModule("tursoPushScheduler.js");
  await sleep(3_000);
  resetTursoPushQueueForTests();
  await sleep(500);
}

async function waitForPushJobCalls(minCalls, timeoutMs = 90_000) {
  const { getTursoPushSchedulerStatsForTests } = await loadModule(
    "tursoPushScheduler.js",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = getTursoPushSchedulerStatsForTests();
    if (stats.pushJobCalls >= minCalls) {
      return stats;
    }
    await sleep(500);
  }
  return getTursoPushSchedulerStatsForTests();
}

async function flushDebouncedPush() {
  const debounce = Number(process.env.TURSO_PUSH_DEBOUNCE_MS ?? 800);
  await sleep(WATCHER_STABILITY_MS + debounce + 500);
}

function writeJobDataSources(appsRoot, appId, jobId, dbPath) {
  fs.mkdirSync(path.join(appsRoot, appId), { recursive: true });
  fs.writeFileSync(
    path.join(appsRoot, appId, "data-sources.json"),
    JSON.stringify(
      {
        primary: "main",
        sources: [
          {
            id: `${jobId}:main`,
            type: "sqlite",
            jobId,
            alias: "main",
            dbPath,
            tables: [],
            linkedAt: new Date().toISOString(),
            role: "primary",
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeRegistryDataSources(appsRoot, appId, dbId, dbPath) {
  fs.mkdirSync(path.join(appsRoot, appId), { recursive: true });
  fs.writeFileSync(
    path.join(appsRoot, appId, "data-sources.json"),
    JSON.stringify(
      {
        primary: "registry",
        sources: [
          {
            id: `${dbId}:registry`,
            type: "sqlite",
            dbId,
            alias: "registry",
            dbPath,
            tables: [],
            linkedAt: new Date().toISOString(),
            role: "primary",
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeRegistryRecord(paprHome, dbId, dbPath, tursoShortName) {
  const dataDir = path.join(paprHome, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "databases.json"),
    JSON.stringify(
      {
        version: 1,
        databases: {
          [dbId]: {
            dbId,
            localPath: dbPath,
            tursoShortName,
            label: "overlap-registry",
            isolation: "shared",
            status: "active",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      },
      null,
      2,
    ),
  );
}

async function setupJobFixture() {
  const paprHome = fs.mkdtempSync(path.join(os.tmpdir(), "papr-overlap-home-"));
  process.env.PAPR_HOME = paprHome;

  const jobRoot = path.join(paprHome, "Jobs");
  const appsRoot = path.join(paprHome, "apps");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(appsRoot, { recursive: true });

  const jobId = randomUUID();
  const dbPath = path.join(jobRoot, jobId, "data", "data.db");
  const appId = "overlap-test-app";

  writeJobDataSources(appsRoot, appId, jobId, dbPath);

  const { initializeTursoSyncBridge } = await loadModule("TursoSyncBridge.js");
  const { getDatabaseRegistryService } = await loadModule(
    "DatabaseRegistryService.js",
  );
  await getDatabaseRegistryService().initialize();

  const bridge = initializeTursoSyncBridge({
    jobsRootDir: jobRoot,
    appsRootDir: appsRoot,
  });

  const logMod = await loadModule("tursoSyncLog.js");
  seedItemsTable(dbPath, "seed-v0");
  const db = new Database(dbPath);
  logMod.ensureLocalSyncInfrastructure(db);
  logMod.ensureLocalTableSyncTriggers(db, "items");
  db.close();

  const push = await bridge.pushJob(jobId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    fail("fixture bootstrap push", push);
  }

  return { paprHome, jobRoot, appsRoot, jobId, dbPath, appId, bridge };
}

async function cloudInsertRow(bridge, syncKey, tursoDbName, label) {
  const core = await loadModule("tursoSyncBridgeCore.js");
  const cloudDb = path.join(os.tmpdir(), `papr-overlap-cloud-${randomUUID()}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials(tursoDbName);
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId: syncKey });
  const writer = new Database(cloudDb);
  writer.prepare("INSERT INTO items (label) VALUES (?)").run(label);
  writer.close();
  await core.pushLocalDbToTurso(cloudDb, credentials, { jobId: syncKey });
  cleanupDb(cloudDb);
}

async function runO1(appsRoot, jobId, dbPath) {
  log("O1. Single local write → one pushJob after debounce...");
  const {
    resetTursoSyncTestHooks,
    getTursoPushSchedulerStatsForTests,
    scheduleTursoPushForJob,
  } = await loadModule("tursoPushScheduler.js");
  const { startTursoLinkedDbWatcher, stopTursoLinkedDbWatcher } = await loadModule(
    "TursoLinkedDbWatcher.js",
  );

  resetTursoSyncTestHooks();
  await startTursoLinkedDbWatcher(appsRoot);

  const db = new Database(dbPath);
  db.prepare("INSERT INTO items (label) VALUES (?)").run(`o1-${Date.now()}`);
  db.close();

  await flushDebouncedPush();
  const stats = await waitForPushJobCalls(1);

  await stopTursoLinkedDbWatcher();

  if (stats.pushJobCalls !== 1) {
    fail("O1", stats);
  }
  log(
    `   ✅ schedules=${stats.schedules} enqueues=${stats.enqueues} pushJobCalls=${stats.pushJobCalls}\n`,
  );
  await drainPushQueue();
}

async function runO2(appsRoot, jobId, dbPath) {
  log("O2. Gateway-style write path (/api/db/write via local SQLite) → one pushJob via watcher...");
  const { resetTursoSyncTestHooks } = await loadModule("tursoPushScheduler.js");
  const { startTursoLinkedDbWatcher, stopTursoLinkedDbWatcher } = await loadModule(
    "TursoLinkedDbWatcher.js",
  );

  resetTursoSyncTestHooks();
  await startTursoLinkedDbWatcher(appsRoot);

  const db = new Database(dbPath);
  db.prepare("INSERT INTO items (label) VALUES (?)").run(`o2-${Date.now()}`);
  db.close();

  // Post-PR3: /api/db/write and /api/db/exec rely on TursoLinkedDbWatcher only.
  await flushDebouncedPush();
  const stats = await waitForPushJobCalls(1);
  await stopTursoLinkedDbWatcher();

  if (stats.pushJobCalls !== 1) {
    fail("O2", stats);
  }
  log(
    `   ✅ coalesced schedules=${stats.schedules} enqueues=${stats.enqueues} pushJobCalls=${stats.pushJobCalls}\n`,
  );
  await drainPushQueue();
}

async function runO3O4(bridge, jobId, dbPath, tursoDbName) {
  log("O3. Cloud db-changed → pull only (zero pushJob)...");
  const { syncTursoFromCloudDbChanged } = await loadModule("TursoSyncBridge.js");
  const {
    resetTursoSyncTestHooks,
    getTursoPushSchedulerStatsForTests,
  } = await loadModule("tursoPushScheduler.js");
  const { stopTursoLinkedDbWatcher } = await loadModule("TursoLinkedDbWatcher.js");
  const { recordTursoPushSuccess } = await loadModule("tursoSyncState.js");

  await stopTursoLinkedDbWatcher();
  await drainPushQueue();

  await cloudInsertRow(bridge, jobId, tursoDbName, "cloud-o3");
  resetTursoSyncTestHooks();

  const summary = await syncTursoFromCloudDbChanged([{ jobId }]);
  const pushStats = getTursoPushSchedulerStatsForTests();

  if (summary.pulled !== 1 || pushStats.pushJobCalls !== 0) {
    fail("O3", { summary, pushStats });
  }
  const labels = readLabels(dbPath);
  if (!labels.includes("cloud-o3")) {
    fail("O3 labels", labels);
  }
  log(`   ✅ pulled=${summary.pulled} pushJobCalls=${pushStats.pushJobCalls}\n`);

  log("O4. Second periodic reconcile → skip (remote unchanged)...");
  recordTursoPushSuccess(jobId, dbPath);
  resetTursoSyncTestHooks();
  const skipSummary = await bridge.reconcileFromCloud({ jobId }, { trigger: "periodic" });
  const afterSkip = getTursoPushSchedulerStatsForTests();
  if (skipSummary.skipped !== 1 || skipSummary.pulled > 0 || afterSkip.pushJobCalls > 0) {
    fail("O4", { skipSummary, afterSkip });
  }
  log(`   ✅ skipped=${skipSummary.skipped}\n`);
}

async function runO5(bridge, paprHome, appsRoot) {
  log("O5. Registry dbId cloud change → local registry SQLite hydrated...");
  const { dbTursoDatabaseName } = await loadModule("tursoDatabaseNaming.js");
  const { syncTursoFromCloudDbChanged } = await loadModule("TursoSyncBridge.js");
  const { getDatabaseRegistryService } = await loadModule(
    "DatabaseRegistryService.js",
  );

  const dbId = `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const regDbPath = path.join(paprHome, "data", "databases", "overlap-reg", "data.db");
  const tursoShortName = dbTursoDatabaseName(dbId);
  const appId = "overlap-registry-app";

  writeRegistryRecord(paprHome, dbId, regDbPath, tursoShortName);
  writeRegistryDataSources(appsRoot, appId, dbId, regDbPath);
  await getDatabaseRegistryService().initialize();

  seedItemsTable(regDbPath, "reg-seed");
  const logMod = await loadModule("tursoSyncLog.js");
  const regDb = new Database(regDbPath);
  logMod.ensureLocalSyncInfrastructure(regDb);
  logMod.ensureLocalTableSyncTriggers(regDb, "items");
  regDb.close();

  bridge.invalidateLinkedSourcesCache();
  const push = await bridge.pushJob(dbId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    fail("O5 bootstrap", push);
  }

  await cloudInsertRow(bridge, dbId, tursoShortName, "cloud-reg-o5");
  cleanupDb(regDbPath);

  const summary = await syncTursoFromCloudDbChanged([{ dbId }]);
  const labels = readLabels(regDbPath);
  if (summary.pulled !== 1 || !labels.includes("cloud-reg-o5")) {
    fail("O5", { summary, labels });
  }
  log(`   ✅ registry hydrated ${JSON.stringify(labels)}\n`);
}

async function runO6(bridge, jobId, dbId, tursoShortName, regDbPath, appsRoot, paprHome) {
  log("O6. jobId db-changed + writeDbIds → registry pull...");
  const { syncTursoFromCloudDbChanged } = await loadModule("TursoSyncBridge.js");

  writeRegistryRecord(paprHome, dbId, regDbPath, tursoShortName);
  writeRegistryDataSources(appsRoot, "overlap-registry-app", dbId, regDbPath);

  const { getDatabaseRegistryService } = await loadModule(
    "DatabaseRegistryService.js",
  );
  await getDatabaseRegistryService().initialize();
  bridge.invalidateLinkedSourcesCache();

  const bootstrap = await bridge.pushJob(dbId);
  if (bootstrap.status !== "pushed" && bootstrap.reason !== "all_tables_unchanged") {
    fail("O6 bootstrap", bootstrap);
  }

  await cloudInsertRow(bridge, dbId, tursoShortName, "cloud-reg-o6");
  cleanupDb(regDbPath);

  const jobWriteDbIds = new Map([[jobId, [dbId]]]);
  const summary = await syncTursoFromCloudDbChanged([{ jobId }], { jobWriteDbIds });
  const labels = readLabels(regDbPath);
  if (summary.pulled < 1 || !labels.includes("cloud-reg-o6")) {
    fail("O6", { summary, labels });
  }
  log(`   ✅ writeDbIds expansion pulled registry ${JSON.stringify(labels)}\n`);
}

async function runO7(bridge, jobId, dbPath) {
  log("O7. Local dirty + db-changed → push session (not double pull)...");
  const { syncTursoFromCloudDbChanged } = await loadModule("TursoSyncBridge.js");
  const { resetTursoSyncTestHooks, getTursoPushSchedulerStatsForTests } =
    await loadModule("tursoPushScheduler.js");

  const db = new Database(dbPath);
  db.prepare("INSERT INTO items (label) VALUES (?)").run(`o7-local-${Date.now()}`);
  db.close();

  resetTursoSyncTestHooks();
  const summary = await syncTursoFromCloudDbChanged([{ jobId }]);
  const pushStats = getTursoPushSchedulerStatsForTests();

  if (summary.pushed < 1 || summary.pulled > 0) {
    fail("O7", { summary, pushStats });
  }
  log(
    `   ✅ pushed=${summary.pushed} pulled=${summary.pulled} schedulerPushJobCalls=${pushStats.pushJobCalls}\n`,
  );
}

async function runO8(appsRoot, jobId, dbPath) {
  log("O8. Rapid 10 writes in 2s → one enqueue...");
  const {
    resetTursoSyncTestHooks,
    scheduleTursoPushForJob,
    getTursoPushSchedulerStatsForTests,
  } = await loadModule("tursoPushScheduler.js");

  resetTursoSyncTestHooks();
  const db = new Database(dbPath);
  for (let i = 0; i < 10; i += 1) {
    db.prepare("INSERT INTO items (label) VALUES (?)").run(`o8-burst-${i}`);
    scheduleTursoPushForJob(jobId, "normal", "watcher");
    await sleep(150);
  }
  db.close();

  await flushDebouncedPush();
  const stats = await waitForPushJobCalls(1);

  if (stats.enqueues !== 1 || stats.pushJobCalls !== 1) {
    fail("O8", stats);
  }
  log(`   ✅ schedules=${stats.schedules} enqueues=${stats.enqueues} pushJobCalls=${stats.pushJobCalls}\n`);
}

async function runO9(bridge, paprHome, appsRoot) {
  log("O9. Sync-index heartbeat → registry db hydrated...");

  const { dbTursoDatabaseName } = await loadModule("tursoDatabaseNaming.js");
  const { syncTursoFromSyncIndex } = await loadModule("TursoSyncBridge.js");
  const { bumpSyncIndexForShortName } = await loadModule("tursoSyncIndex.js");
  const { getDatabaseRegistryService } = await loadModule(
    "DatabaseRegistryService.js",
  );

  const dbId = `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const regDbPath = path.join(paprHome, "data", "databases", "overlap-reg-o9", "data.db");
  const tursoShortName = dbTursoDatabaseName(dbId);
  const appId = "overlap-registry-app-o9";

  writeRegistryRecord(paprHome, dbId, regDbPath, tursoShortName);
  writeRegistryDataSources(appsRoot, appId, dbId, regDbPath);
  await getDatabaseRegistryService().initialize();

  seedItemsTable(regDbPath, "reg-o9-seed");
  const logMod = await loadModule("tursoSyncLog.js");
  const regDb = new Database(regDbPath);
  logMod.ensureLocalSyncInfrastructure(regDb);
  logMod.ensureLocalTableSyncTriggers(regDb, "items");
  regDb.close();

  bridge.invalidateLinkedSourcesCache();
  const push = await bridge.pushJob(dbId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    fail("O9 bootstrap", push);
  }

  await cloudInsertRow(bridge, dbId, tursoShortName, "cloud-reg-o9");
  cleanupDb(regDbPath);

  const bumped = await bumpSyncIndexForShortName(
    (shortName) => bridge.fetchCredentials(shortName),
    tursoShortName,
  );
  if (!bumped || bumped < 1) {
    fail("O9 index bump", { bumped });
  }

  const summary = await syncTursoFromSyncIndex();
  const labels = readLabels(regDbPath);
  if (summary.pulled !== 1 || !labels.includes("cloud-reg-o9")) {
    fail("O9", { summary, labels, bumped });
  }
  log(`   ✅ sync-index pulled registry ${JSON.stringify(labels)}\n`);
}

async function main() {
  log("\n=== Turso Sync Overlap E2E ===\n");

  const health = await fetch(`${process.env.PAPR_MEMORY_SERVER_URL}/health`).catch(
    () => null,
  );
  if (!health?.ok) {
    console.error(
      "Memory server not reachable at",
      process.env.PAPR_MEMORY_SERVER_URL,
    );
    process.exit(1);
  }

  const fixture = await setupJobFixture();
  const tursoDbName = fixture.bridge.tursoDatabaseNameForJob(fixture.jobId);

  await runO1(fixture.appsRoot, fixture.jobId, fixture.dbPath);
  await runO2(fixture.appsRoot, fixture.jobId, fixture.dbPath);
  await runO3O4(fixture.bridge, fixture.jobId, fixture.dbPath, tursoDbName);
  await runO5(fixture.bridge, fixture.paprHome, fixture.appsRoot);

  const dbId = `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const { dbTursoDatabaseName } = await loadModule("tursoDatabaseNaming.js");
  const tursoShortName = dbTursoDatabaseName(dbId);
  const regDbPath = path.join(fixture.paprHome, "data", "databases", "overlap-reg2", "data.db");
  seedItemsTable(regDbPath, "reg-o6-seed");
  const logMod = await loadModule("tursoSyncLog.js");
  const regSetup = new Database(regDbPath);
  logMod.ensureLocalSyncInfrastructure(regSetup);
  logMod.ensureLocalTableSyncTriggers(regSetup, "items");
  regSetup.close();
  await runO6(
    fixture.bridge,
    fixture.jobId,
    dbId,
    tursoShortName,
    regDbPath,
    fixture.appsRoot,
    fixture.paprHome,
  );

  await runO7(fixture.bridge, fixture.jobId, fixture.dbPath);
  await runO8(fixture.appsRoot, fixture.jobId, fixture.dbPath);
  await runO9(fixture.bridge, fixture.paprHome, fixture.appsRoot);

  fs.rmSync(fixture.paprHome, { recursive: true, force: true });

  log("\n✅ Turso sync overlap E2E passed (O1–O9)!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
