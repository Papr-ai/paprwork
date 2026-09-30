#!/usr/bin/env node
/**
 * Integration test — Turso cloud→local sync session (scoped pull, remote-ahead skip, push-if-dirty).
 *
 * NOT full cloud E2E: calls syncTursoFromCloudDbChanged directly instead of memory server
 * heartbeat pendingTursoDbChanges. Uses real Turso + temp PAPR_HOME.
 *
 * Prerequisites:
 *   npm run build:gateway
 *   Memory server + PAPR_API_KEY
 *
 * Usage:
 *   npm run test:turso-sync-session-e2e
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
// Isolated sandbox — do not inherit desktop workspace pointer for key resolution
process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";

function log(msg) {
  console.log(msg);
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

async function loadBridge(jobRoot, appsRoot) {
  const mod = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/TursoSyncBridge.js"),
    ).href
  );
  return mod.initializeTursoSyncBridge({
    jobsRootDir: jobRoot,
    appsRootDir: appsRoot,
  });
}

async function main() {
  log("\n=== Turso Sync Session E2E ===\n");

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

  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-session-"));
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-apps-"));
  const jobId = randomUUID();
  const jobDir = path.join(jobRoot, jobId, "data");
  fs.mkdirSync(jobDir, { recursive: true });
  const desktopDb = path.join(jobDir, "data.db");
  cleanupDb(desktopDb);

  const appId = "session-test-app";
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
            dbPath: desktopDb,
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

  const bridge = await loadBridge(jobRoot, appsRoot);
  const core = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js"),
    ).href
  );
  const logMod = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/tursoSyncLog.js"),
    ).href
  );
  const tursoDbName = bridge.tursoDatabaseNameForJob(jobId);

  log("1. Seed local + push to Turso...");
  const db = new Database(desktopDb);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL
    );
  `);
  logMod.ensureLocalSyncInfrastructure(db);
  logMod.ensureLocalTableSyncTriggers(db, "items");
  db.prepare("INSERT INTO items (label) VALUES (?)").run("local-v1");
  db.close();
  const push1 = await bridge.pushJob(jobId);
  if (push1.status !== "pushed") {
    console.error("❌ FAIL: initial push", push1);
    process.exit(1);
  }
  log("   ✅ pushed local-v1\n");

  log("2. reconcileFromCloud (remote unchanged) → should skip...");
  const skipSummary = await bridge.reconcileFromCloud(
    { jobId },
    { trigger: "periodic" },
  );
  if (skipSummary.pulled > 0 || skipSummary.pushed > 0) {
    console.error("❌ FAIL: expected skip when remote unchanged", skipSummary);
    process.exit(1);
  }
  if (skipSummary.skipped !== 1) {
    console.error("❌ FAIL: expected 1 skipped source", skipSummary);
    process.exit(1);
  }
  log(`   ✅ skipped (${skipSummary.skipped} source(s))\n`);

  log("3. Cloud writes new row to Turso...");
  const cloudDb = path.join(os.tmpdir(), `papr-session-cloud-${jobId}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials(tursoDbName);
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId });
  const cloudTables = new Database(cloudDb, { readonly: true })
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (!cloudTables.some((row) => row.name === "items")) {
    console.error("❌ FAIL: cloud pull missing items table", cloudTables);
    process.exit(1);
  }
  const cloudWrite = new Database(cloudDb);
  cloudWrite.prepare("INSERT INTO items (label) VALUES (?)").run("cloud-v2");
  cloudWrite.close();
  await core.pushLocalDbToTurso(cloudDb, credentials, { jobId });
  log("   ✅ cloud-v2 on Turso\n");

  log("4. reconcileFromCloud (remote ahead) → should pull cloud row...");
  cleanupDb(desktopDb);
  const pullSummary = await bridge.reconcileFromCloud(
    { appId },
    { trigger: "app_open" },
  );
  if (pullSummary.pulled !== 1) {
    console.error("❌ FAIL: expected pull", pullSummary);
    process.exit(1);
  }
  const afterPull = new Database(desktopDb, { readonly: true })
    .prepare("SELECT label FROM items ORDER BY id")
    .all();
  if (
    afterPull.length !== 2 ||
    afterPull[1]?.label !== "cloud-v2"
  ) {
    console.error("❌ FAIL: desktop missing cloud row", afterPull);
    process.exit(1);
  }
  log(`   ✅ desktop has ${JSON.stringify(afterPull.map((r) => r.label))}\n`);

  log("5. Cloud db-changed reconcile → pull cloud row...");
  const { syncTursoFromCloudDbChanged } = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/TursoSyncBridge.js"),
    ).href
  );
  cleanupDb(desktopDb);
  const dbChangedSummary = await syncTursoFromCloudDbChanged([{ jobId }]);
  if (dbChangedSummary.pulled !== 1) {
    console.error("❌ FAIL: db-changed reconcile expected pull", dbChangedSummary);
    process.exit(1);
  }
  const afterDbChanged = new Database(desktopDb, { readonly: true })
    .prepare("SELECT label FROM items ORDER BY id")
    .all();
  if (
    afterDbChanged.length !== 2 ||
    afterDbChanged[1]?.label !== "cloud-v2"
  ) {
    console.error("❌ FAIL: db-changed missing cloud row", afterDbChanged);
    process.exit(1);
  }
  log(`   ✅ db-changed hydrated ${JSON.stringify(afterDbChanged.map((r) => r.label))}\n`);

  log("6. Local dirty + reconcile → push session (local wins then hydrates)...");
  const localWrite = new Database(desktopDb);
  localWrite.prepare("INSERT INTO items (label) VALUES (?)").run("local-v3");
  localWrite.close();
  const dirtySummary = await bridge.reconcileFromCloud(
    { jobId },
    { trigger: "manual" },
  );
  if (dirtySummary.pushed < 1) {
    console.error("❌ FAIL: expected push when local dirty", dirtySummary);
    process.exit(1);
  }
  log(`   ✅ push session pushed=${dirtySummary.pushed} pulled=${dirtySummary.pulled}\n`);

  cleanupDb(cloudDb);
  fs.rmSync(jobRoot, { recursive: true, force: true });
  fs.rmSync(appsRoot, { recursive: true, force: true });

  log("\n✅ Turso sync session E2E passed!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
