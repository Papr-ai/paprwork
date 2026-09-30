/**
 * Shared helpers for Turso bidirectional merge E2E tests.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

export const WATCHER_STABILITY_MS = 2_100;

export function cleanupDb(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createModuleLoader(distGatewayServicesDir) {
  return async function loadModule(relativePath) {
    return import(
      pathToFileURL(path.join(distGatewayServicesDir, relativePath)).href
    );
  };
}

export function seedItemsTable(dbPath, label) {
  cleanupDb(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run(randomUUID(), label);
  db.close();
}

export function readLabels(dbPath) {
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

export function writeJobDataSources(appsRoot, appId, jobId, dbPath) {
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

export async function ensureLocalSyncTriggers(loadModule, dbPath, tableName = "items") {
  const logMod = await loadModule("tursoSyncLog.js");
  const db = new Database(dbPath);
  logMod.ensureLocalSyncInfrastructure(db);
  logMod.ensureLocalTableSyncTriggers(db, tableName);
  db.close();
}

export async function localInsertRow(loadModule, dbPath, label) {
  await ensureLocalSyncTriggers(loadModule, dbPath);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run(randomUUID(), label);
  db.close();
}

export async function cloudInsertRow(loadModule, bridge, syncKey, tursoDbName, label) {
  // Prefer remote-direct insert (matches cloud mini-app / TursoDbAdapter writes).
  await cloudInsertRowOnRemote(loadModule, bridge, tursoDbName, label);
}

/** Simulate cloud/web write — INSERT on Turso remote with CDC triggers + version bump. */
export async function cloudInsertRowOnRemote(loadModule, bridge, tursoDbName, label) {
  const core = await loadModule("tursoSyncBridgeCore.js");
  const logMod = await loadModule("tursoSyncLog.js");
  const credentials = await bridge.fetchCredentials(tursoDbName);
  const remote = core.createRemoteClient(credentials);
  try {
    await logMod.ensureRemoteSyncInfrastructure(remote);
    const columns = await core.readRemoteTableSchema(remote, "items");
    if (columns.length === 0) {
      throw new Error("items table missing on remote for cloud insert");
    }
    await logMod.ensureRemoteTableSyncTriggers(remote, columns, "items");
    await remote.execute({
      sql: `INSERT INTO ${core.quoteIdent("items")} (id, label) VALUES (?, ?)`,
      args: [randomUUID(), label],
    });
    await core.bumpRemoteSyncVersion(remote);
  } finally {
    remote.close();
  }
}

export async function cloudInsertRowLegacyLocalPush(
  loadModule,
  bridge,
  syncKey,
  tursoDbName,
  label,
) {
  const core = await loadModule("tursoSyncBridgeCore.js");
  const cloudDb = path.join(os.tmpdir(), `papr-bidir-cloud-${randomUUID()}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials(tursoDbName);
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId: syncKey });
  const logMod = await loadModule("tursoSyncLog.js");
  const writer = new Database(cloudDb);
  logMod.ensureLocalSyncInfrastructure(writer);
  logMod.ensureLocalTableSyncTriggers(writer, "items");
  writer.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run(randomUUID(), label);
  writer.close();
  await core.pushLocalDbToTurso(cloudDb, credentials, { jobId: syncKey });
  cleanupDb(cloudDb);
}

export async function readRemoteLabels(loadModule, bridge, syncKey, tursoDbName) {
  const core = await loadModule("tursoSyncBridgeCore.js");
  const cloudDb = path.join(os.tmpdir(), `papr-bidir-read-${randomUUID()}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials(tursoDbName);
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId: syncKey });
  const labels = readLabels(cloudDb);
  cleanupDb(cloudDb);
  return labels;
}

/**
 * Bootstrap a linked job DB, push seed to Turso, return fixture handles.
 * @param {object} opts
 * @param {string} opts.prefix temp dir prefix
 * @param {string} opts.seedLabel
 * @param {ReturnType<typeof createModuleLoader>} opts.loadModule
 */
export async function setupBidirectionalFixture(opts) {
  const paprHome = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.prefix}-home-`));
  process.env.PAPR_HOME = paprHome;

  const jobRoot = path.join(paprHome, "Jobs");
  const appsRoot = path.join(paprHome, "apps");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(appsRoot, { recursive: true });

  const jobId = randomUUID();
  const dbPath = path.join(jobRoot, jobId, "data", "data.db");
  const appId = `${opts.prefix}-app`;

  writeJobDataSources(appsRoot, appId, jobId, dbPath);

  const { initializeTursoSyncBridge } = await opts.loadModule("TursoSyncBridge.js");
  const { getDatabaseRegistryService } = await opts.loadModule(
    "DatabaseRegistryService.js",
  );
  await getDatabaseRegistryService().initialize();

  const bridge = initializeTursoSyncBridge({
    jobsRootDir: jobRoot,
    appsRootDir: appsRoot,
  });

  seedItemsTable(dbPath, opts.seedLabel);
  await ensureLocalSyncTriggers(opts.loadModule, dbPath);

  const push = await bridge.pushJob(jobId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    throw new Error(`fixture bootstrap push failed: ${JSON.stringify(push)}`);
  }

  const tursoDbName = bridge.tursoDatabaseNameForJob(jobId);
  return { paprHome, jobRoot, appsRoot, jobId, dbPath, appId, bridge, tursoDbName };
}

export async function assertBidirectionalMerge(ctx, scenario, webLabel, desktopLabel) {
  const localLabels = readLabels(ctx.dbPath);
  if (!localLabels.includes(webLabel) || !localLabels.includes(desktopLabel)) {
    throw new Error(
      `[${scenario}] local missing rows: expected web=${webLabel} desktop=${desktopLabel} got ${JSON.stringify(localLabels)}`,
    );
  }

  const remoteLabels = await readRemoteLabels(
    ctx.loadModule,
    ctx.bridge,
    ctx.jobId,
    ctx.tursoDbName,
  );
  if (!remoteLabels.includes(webLabel) || !remoteLabels.includes(desktopLabel)) {
    throw new Error(
      `[${scenario}] remote missing rows: expected web=${webLabel} desktop=${desktopLabel} got ${JSON.stringify(remoteLabels)}`,
    );
  }
}

export async function bumpSyncIndexForDatabase(loadModule, bridge, tursoDbName) {
  const { bumpSyncIndexForShortName } = await loadModule("tursoSyncIndex.js");
  const bumped = await bumpSyncIndexForShortName(
    (shortName) => bridge.fetchCredentials(shortName),
    tursoDbName,
  );
  if (!bumped || bumped < 1) {
    throw new Error(`sync-index bump failed for ${tursoDbName}: ${bumped}`);
  }
  return bumped;
}

export async function drainPushQueue(loadModule) {
  const { resetTursoPushQueueForTests } = await loadModule("tursoPushScheduler.js");
  await sleep(3_000);
  resetTursoPushQueueForTests();
  await sleep(500);
}

export async function waitForPushJobCalls(loadModule, minCalls, timeoutMs = 90_000) {
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

export async function flushDebouncedPush() {
  const debounce = Number(process.env.TURSO_PUSH_DEBOUNCE_MS ?? 800);
  await sleep(WATCHER_STABILITY_MS + debounce + 500);
}
