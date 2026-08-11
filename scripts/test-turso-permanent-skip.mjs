#!/usr/bin/env node
/**
 * Verifies permanent Turso push skips (no_syncable_tables) clear dirty state
 * and do not re-arm max_wait every 120s.
 *
 * Usage:
 *   npm run test:turso-permanent-skip
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpPapr = fs.mkdtempSync(path.join(os.tmpdir(), "papr-perm-skip-e2e-"));
fs.mkdirSync(path.join(tmpPapr, "data"), { recursive: true });
process.env.PAPR_HOME = tmpPapr;
process.env.TURSO_PUSH_MAX_WAIT_MS = "2000";
process.env.TURSO_PUSH_DEBOUNCE_MS = "60000";

async function loadGateway(relativePath) {
  return import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services", relativePath)).href
  );
}

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  console.error(`  ❌ ${msg}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmpJobDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-perm-skip-e2e-"));
  const dbPath = path.join(tmpJobDir, "data.db");
  const syncKey = "job-empty-e2e";
  const dbId = "db-empty-e2e";

  const db = new Database(dbPath);
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  db.close();

  const {
    localDbHasSyncableData,
    markDbDirty,
    loadTursoSyncState,
    isJobDbDirty,
  } = await loadGateway("tursoSyncState.js");

  if (localDbHasSyncableData(dbPath)) {
    fail("expected infra-only DB to have no syncable data");
  } else {
    pass("infra-only DB has no syncable data");
  }

  markDbDirty(dbId, dbPath);
  let state = loadTursoSyncState();
  if (!state.jobs[dbId]?.dirtyFlag) {
    fail("markDbDirty should set dirtyFlag");
  } else {
    pass("markDbDirty sets dirtyFlag before push");
  }

  const bridgeMod = await loadGateway("TursoSyncBridge.js");
  const linked = {
    appId: "app-empty-e2e",
    jobId: syncKey,
    dbId,
    dbPath,
    alias: "primary",
  };

  const bridge = bridgeMod.initializeTursoSyncBridge({
    jobsRootDir: tmpJobDir,
    appsRootDir: path.join(tmpPapr, "apps"),
  });
  bridge.isJobLinkedToApp = async () => true;
  bridge.listLinkedSources = async () => [linked];
  bridge.linkedSourceNeedsPush = async () => true;
  bridge.pushJob = async () => ({
    status: "skipped",
    tables: [],
    reason: "no_syncable_tables",
  });

  const schedulerMod = await loadGateway("tursoPushScheduler.js");
  schedulerMod.resetTursoPushQueueForTests();

  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => {
    logs.push(["log", ...args]);
    origLog(...args);
  };
  console.warn = (...args) => {
    logs.push(["warn", ...args]);
    origWarn(...args);
  };

  schedulerMod.scheduleTursoPushForJob(syncKey, "normal", "startup");
  await sleep(2500);
  await schedulerMod.awaitTursoPushQueueForTests();

  state = loadTursoSyncState();
  if (state.jobs[dbId]?.dirtyFlag) {
    fail("dirtyFlag should be cleared after permanent skip");
  } else {
    pass("dirtyFlag cleared after permanent skip");
  }

  if (JSON.stringify(state.jobs[dbId]?.tableFingerprints ?? null) !== "{}") {
    fail(
      `expected empty tableFingerprints, got ${JSON.stringify(state.jobs[dbId]?.tableFingerprints)}`,
    );
  } else {
    pass("empty tableFingerprints recorded");
  }

  if (isJobDbDirty(dbId, dbPath, state)) {
    fail("isJobDbDirty should be false after permanent skip");
  } else {
    pass("isJobDbDirty is false after permanent skip");
  }

  if (schedulerMod.getFirstDirtyAtMsForTests(syncKey) !== undefined) {
    fail("scheduler firstDirtyAtMs should be cleared");
  } else {
    pass("scheduler in-memory dirty tracking cleared");
  }

  const maxWaitBefore = logs.filter(
    (entry) =>
      typeof entry[1] === "string" &&
      entry[1].includes("[TursoPushScheduler]") &&
      entry[1].includes("trigger=max_wait"),
  ).length;

  await sleep(2500);
  await schedulerMod.awaitTursoPushQueueForTests();

  const maxWaitAfter = logs.filter(
    (entry) =>
      typeof entry[1] === "string" &&
      entry[1].includes("[TursoPushScheduler]") &&
      entry[1].includes("trigger=max_wait"),
  ).length;

  if (maxWaitAfter > maxWaitBefore) {
    fail(
      `max_wait fired again after permanent skip (${maxWaitBefore} → ${maxWaitAfter})`,
    );
  } else {
    pass("no second max_wait within 2.5s idle after permanent skip");
  }

  const skipWarns = logs.filter(
    (entry) =>
      entry[0] === "warn" &&
      typeof entry[1] === "string" &&
      entry[1].includes("no_syncable_tables"),
  ).length;
  if (skipWarns > 0) {
    fail(`unexpected no_syncable_tables warn logs (${skipWarns})`);
  } else {
    pass("no repeat no_syncable_tables warn spam");
  }

  const { SyncCoordinator } = await loadGateway("cloudSync/SyncCoordinator.js");

  const scheduleLogsBefore = logs.filter(
    (entry) =>
      typeof entry[1] === "string" &&
      entry[1].includes("[TursoPushScheduler] Schedule push"),
  ).length;

  const coordinator = new SyncCoordinator({
    getPaprDir: () => tmpPapr,
    enqueueRelativePath: () => {},
  });
  coordinator.markDbDirty(dbId, dbPath, "watcher");

  const scheduleLogsAfter = logs.filter(
    (entry) =>
      typeof entry[1] === "string" &&
      entry[1].includes("[TursoPushScheduler] Schedule push"),
  ).length;

  if (scheduleLogsAfter > scheduleLogsBefore) {
    fail("SyncCoordinator should not schedule push for infra-only DB");
  } else {
    pass("SyncCoordinator skips infra-only DB");
  }

  if (loadTursoSyncState().jobs[dbId]?.dirtyFlag) {
    fail("SyncCoordinator should not set dirtyFlag on infra-only DB");
  } else {
    pass("SyncCoordinator does not mark infra-only DB dirty");
  }

  console.log = origLog;
  console.warn = origWarn;
  schedulerMod.resetTursoPushQueueForTests();

  fs.rmSync(tmpPapr, { recursive: true, force: true });
  fs.rmSync(tmpJobDir, { recursive: true, force: true });

  if (!process.exitCode) {
    console.log("\nAll permanent-skip checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
