#!/usr/bin/env node
/**
 * Full Turso sync-index E2E:
 *   cloud Turso write → memory turso-db-changed → sync-index bump → desktop heartbeat poll → local hydrate
 *
 * Requires PAPR_API_KEY + reachable memory server + Turso.
 *
 *   npm run test:cloud-turso-db-changed-e2e
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

const MEMORY_BASE = process.env.PAPR_MEMORY_SERVER_URL;

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

async function setupJobFixture() {
  const paprHome = fs.mkdtempSync(path.join(os.tmpdir(), "papr-turso-changed-"));
  process.env.PAPR_HOME = paprHome;

  const jobRoot = path.join(paprHome, "Jobs");
  const appsRoot = path.join(paprHome, "apps");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(appsRoot, { recursive: true });

  const jobId = randomUUID();
  const dbPath = path.join(jobRoot, jobId, "data", "data.db");
  const appId = "turso-changed-e2e-app";

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
  seedItemsTable(dbPath, "seed-bootstrap");
  const db = new Database(dbPath);
  logMod.ensureLocalSyncInfrastructure(db);
  logMod.ensureLocalTableSyncTriggers(db, "items");
  db.close();

  const push = await bridge.pushJob(jobId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    fail("fixture bootstrap push", push);
  }

  return { paprHome, jobId, dbPath, bridge };
}

async function cloudInsertRow(bridge, syncKey, tursoDbName, label) {
  const core = await loadModule("tursoSyncBridgeCore.js");
  const cloudDb = path.join(os.tmpdir(), `papr-changed-cloud-${randomUUID()}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials(tursoDbName);
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId: syncKey });
  const writer = new Database(cloudDb);
  writer.prepare("INSERT INTO items (label) VALUES (?)").run(label);
  writer.close();
  await core.pushLocalDbToTurso(cloudDb, credentials, { jobId: syncKey });
  cleanupDb(cloudDb);
}

async function bumpSyncIndexForJob(bridge, jobId, tursoDbName) {
  const res = await fetch(`${MEMORY_BASE}/v1/cloud/runtime/turso-db-changed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify({ jobId, source: "e2e-test" }),
  });

  if (res.ok) {
    const body = await res.json();
    if (!body.recorded) {
      fail("turso-db-changed recorded", body);
    }
    if (typeof body.indexVersion !== "number" || body.indexVersion < 1) {
      fail("turso-db-changed indexVersion", body);
    }
    log(`   via memory API (indexVersion=${body.indexVersion})`);
    return { indexVersion: body.indexVersion, viaMemory: true };
  }

  if (res.status === 404 || res.status === 501) {
    log(
      `   memory turso-db-changed unavailable (${res.status}) — direct Turso bump (same sync-index table)`,
    );
    const { bumpSyncIndexForShortName } = await loadModule("tursoSyncIndex.js");
    const indexVersion = await bumpSyncIndexForShortName(
      (shortName) => bridge.fetchCredentials(shortName),
      tursoDbName,
    );
    if (!indexVersion || indexVersion < 1) {
      fail("direct sync-index bump", { indexVersion });
    }
    return { indexVersion, viaMemory: false };
  }

  fail("turso-db-changed", `${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  log("\n=== Cloud Turso db-changed → sync-index → desktop E2E ===\n");

  const health = await fetch(`${MEMORY_BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error("Memory server not reachable at", MEMORY_BASE);
    process.exit(1);
  }

  const { jobId, dbPath, bridge, paprHome } = await setupJobFixture();
  const tursoDbName = bridge.tursoDatabaseNameForJob(jobId);
  const cloudLabel = `cloud-changed-${Date.now()}`;

  log("1. Simulate cloud write (insert row on Turso)...");
  await cloudInsertRow(bridge, jobId, tursoDbName, cloudLabel);

  log("2. Wipe local SQLite (desktop stale)...");
  cleanupDb(dbPath);

  log("3. Bump sync-index (memory API or direct Turso)...");
  const { indexVersion, viaMemory } = await bumpSyncIndexForJob(
    bridge,
    jobId,
    tursoDbName,
  );
  if (!viaMemory) {
    log("   ⚠ deploy memory with turso-db-changed to exercise cloud app host path");
  }

  log("4. Desktop heartbeat path: syncTursoFromSyncIndex()...");
  const { syncTursoFromSyncIndex } = await loadModule("TursoSyncBridge.js");
  const summary = await syncTursoFromSyncIndex();

  const labels = readLabels(dbPath);
  if (summary.pulled !== 1 || !labels.includes(cloudLabel)) {
    fail("desktop hydrate", { summary, labels, indexVersion });
  }

  log(`   ✅ pulled=${summary.pulled} labels=${JSON.stringify(labels)}\n`);

  fs.rmSync(paprHome, { recursive: true, force: true });
  log("✅ Cloud Turso db-changed E2E passed!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
