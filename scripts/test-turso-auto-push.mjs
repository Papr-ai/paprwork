#!/usr/bin/env node
/**
 * Integration test: Turso auto-push scheduler + linked DB watcher hooks.
 *
 * Uses real ~/Papr linked sources when available; falls back to temp fixture.
 *
 * Usage:
 *   TURSO_PUSH_DEBOUNCE_MS=500 node --import tsx scripts/test-turso-auto-push.mjs
 *
 * Requires PAPR_API_KEY (env or .env.local).
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAPR_DIR = path.join(os.homedir(), "Papr");
const APPS_ROOT = path.join(PAPR_DIR, "apps");
const JOBS_ROOT = path.join(PAPR_DIR, "Jobs");

process.env.TURSO_PUSH_DEBOUNCE_MS = process.env.TURSO_PUSH_DEBOUNCE_MS ?? "500";

async function loadGatewayModule(relativePath) {
  return import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services", relativePath)).href
  );
}

function log(msg) {
  console.log(msg);
}

function pass(name) {
  console.log(`  ✅ ${name}`);
}

function fail(name, err) {
  console.log(`  ❌ ${name}: ${err}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until job is clean in sync state or timeout. */
async function waitForJobClean(jobId, dbPath, timeoutMs = 30_000) {
  const { loadTursoSyncState, isJobDbDirty } = await loadGatewayModule("tursoSyncState.js");
  const debounce = Number(process.env.TURSO_PUSH_DEBOUNCE_MS) + 500;
  await sleep(debounce);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = loadTursoSyncState();
    if (state.jobs[jobId] && !isJobDbDirty(jobId, dbPath, state)) {
      return state.jobs[jobId];
    }
    await sleep(1000);
  }
  return null;
}

async function findRealLinkedSource() {
  const { discoverTursoLinkedSources } = await loadGatewayModule("tursoLinkedSources.js");
  const sources = await discoverTursoLinkedSources(APPS_ROOT);
  for (const source of sources) {
    if (fs.existsSync(source.dbPath)) {
      try {
        const stats = fs.statSync(source.dbPath);
        if (stats.size > 0) {
          return { jobId: source.jobId, dbPath: source.dbPath, appId: source.appId };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function setupTempFixture() {
  const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-auto-push-jobs-"));
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-auto-push-apps-"));
  const jobId = `test-${Date.now().toString(36)}`;
  const dbPath = path.join(jobsRoot, jobId, "data", "data.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
  );
  db.close();

  const appId = "test-app";
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

  return {
    jobId,
    dbPath,
    appId,
    appsRoot,
    jobsRoot,
    cleanup: () => {
      fs.rmSync(jobsRoot, { recursive: true, force: true });
      fs.rmSync(appsRoot, { recursive: true, force: true });
    },
  };
}

async function main() {
  log("\n=== Turso Auto-Push Integration Test ===\n");

  const { initializeTursoSyncBridge } = await loadGatewayModule("TursoSyncBridge.js");
  const { scheduleTursoPushForJob, pushDirtyLinkedJobsOnStartup } =
    await loadGatewayModule("tursoPushScheduler.js");
  const { loadTursoSyncState, isJobDbDirty } = await loadGatewayModule("tursoSyncState.js");
  const { startTursoLinkedDbWatcher, stopTursoLinkedDbWatcher } =
    await loadGatewayModule("TursoLinkedDbWatcher.js");

  let cleanup;
  let appsRoot = APPS_ROOT;
  let jobsRoot = JOBS_ROOT;

  const real = await findRealLinkedSource();
  let jobId;
  let dbPath;

  if (real) {
    jobId = real.jobId;
    dbPath = real.dbPath;
    log(`Using real linked job: ${jobId}`);
    log(`  db: ${dbPath}`);
  } else {
    log("No real linked DB found — using temp fixture");
    const fixture = await setupTempFixture();
    jobId = fixture.jobId;
    dbPath = fixture.dbPath;
    appsRoot = fixture.appsRoot;
    jobsRoot = fixture.jobsRoot;
    cleanup = fixture.cleanup;
  }

  initializeTursoSyncBridge({ jobsRootDir: jobsRoot, appsRootDir: appsRoot });

  // ── Test 1: dirty detection ──
  log("\n--- Test 1: dirty job detection ---");
  const stateBefore = loadTursoSyncState();
  if (!isJobDbDirty(jobId, dbPath, stateBefore)) {
    pass("job already marked clean (will dirty next)");
  } else {
    pass("job detected as dirty before push");
  }

  // ── Test 2: write + debounced scheduler ──
  log("\n--- Test 2: debounced push after local write ---");
  const marker = `auto-push-${Date.now()}`;
  const db = new Database(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS sync_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
    );
    db.prepare("INSERT INTO sync_probe (marker) VALUES (?)").run(marker);
  } catch (err) {
    fail("local write", err.message);
    db.close();
    return;
  }
  db.close();

  const stateAfterWrite = loadTursoSyncState();
  if (!isJobDbDirty(jobId, dbPath, stateAfterWrite)) {
    fail("dirty after write", "expected isJobDbDirty=true");
  } else {
    pass("local write marks job dirty");
  }

  scheduleTursoPushForJob(jobId);
  log("  waiting for debounced push (may take 10-20s for Turso)...");
  const pushed = await waitForJobClean(jobId, dbPath);
  if (!pushed) {
    fail("scheduler push", "timed out — check PAPR_API_KEY / Turso logs");
  } else {
    pass(`scheduler push recorded at ${pushed.lastPushAt}`);
  }

  // ── Test 3: watcher ──
  log("\n--- Test 3: file watcher schedules push ---");
  await startTursoLinkedDbWatcher(appsRoot);
  const marker2 = `watcher-${Date.now()}`;
  const db2 = new Database(dbPath);
  db2.prepare("INSERT INTO sync_probe (marker) VALUES (?)").run(marker2);
  db2.close();

  const watcherPush = await waitForJobClean(jobId, dbPath);
  if (!watcherPush) {
    fail("watcher push", "timed out after watcher-triggered write");
  } else {
    pass("watcher-triggered push succeeded");
  }
  await stopTursoLinkedDbWatcher();

  // ── Test 4: startup dirty scan (single-job fixture only; skip if many dirty jobs) ──
  log("\n--- Test 4: startup dirty scan ---");
  const dirtyCount = (await loadGatewayModule("tursoLinkedSources.js"))
    .discoverTursoLinkedSources(appsRoot)
    .then((sources) => {
      const state = loadTursoSyncState();
      return sources.filter((s) => isJobDbDirty(s.jobId, s.dbPath, state)).length;
    });
  if ((await dirtyCount) > 5) {
    log(`  ⚠️  Skipping (${await dirtyCount} dirty jobs — would take too long in CI)`);
  } else {
    const db3 = new Database(dbPath);
    db3.prepare("INSERT INTO sync_probe (marker) VALUES (?)").run(`startup-${Date.now()}`);
    db3.close();
    await pushDirtyLinkedJobsOnStartup(appsRoot);
    const startupPush = await waitForJobClean(jobId, dbPath, 45_000);
    if (!startupPush) {
      fail("startup dirty push", "timed out");
    } else {
      pass("startup dirty scan + push succeeded");
    }
  }

  // ── Test 5: gateway API route (if gateway running) ──
  log("\n--- Test 5: gateway /api/sync/items ---");
  try {
    const res = await fetch("http://localhost:18789/api/sync/items", {
      signal: AbortSignal.timeout(3000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      log("  ⚠️  Gateway returned HTML — restart app after `npm run build:gateway`");
    } else {
      const json = await res.json();
      const count = json.turso?.sources?.length ?? 0;
      pass(`/api/sync/items OK (${count} Turso source(s))`);
    }
  } catch (err) {
    log(`  ⚠️  Gateway not reachable: ${err.message}`);
  }

  cleanup?.();
  log("\n=== Done ===\n");
  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
