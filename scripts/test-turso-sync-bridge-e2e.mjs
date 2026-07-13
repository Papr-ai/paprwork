#!/usr/bin/env node
/**
 * E2E test for TursoSyncBridge (TypeScript implementation).
 *
 * Prerequisites:
 *   - Memory server on PAPR_MEMORY_SERVER_URL (default http://localhost:5001)
 *   - Turso credentials in memory/.env
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-turso-sync-bridge-e2e.mjs
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { requirePaprApiKey } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = requirePaprApiKey();

process.env.PAPR_MEMORY_SERVER_URL =
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://localhost:5001";
process.env.PAPR_API_KEY = API_KEY;
process.env.NODE_ENV = "development";

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
  log("\n=== TursoSyncBridge TypeScript E2E Test ===\n");

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

  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-turso-bridge-"));
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-turso-apps-"));
  const jobId = `e2e-${Date.now().toString(36)}`;
  const jobDir = path.join(jobRoot, jobId, "data");
  fs.mkdirSync(jobDir, { recursive: true });
  const desktopDb = path.join(jobDir, "data.db");
  cleanupDb(desktopDb);

  const appId = "test-dashboard";
  const appDir = path.join(appsRoot, appId);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "data-sources.json"),
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
  log(`Job root: ${jobRoot}`);
  log(`Apps root: ${appsRoot}`);
  log(`Job id: ${jobId}\n`);

  log("1. Desktop job writes data.db (better-sqlite3)...");
  const desktop = new Database(desktopDb);
  desktop.pragma("journal_mode = WAL");
  desktop.exec(`
    CREATE TABLE tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL,
      content TEXT NOT NULL,
      likes INTEGER DEFAULT 0
    );
    CREATE TABLE job_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT
    );
  `);
  desktop
    .prepare("INSERT INTO tweets (handle, content, likes) VALUES (?, ?, ?)")
    .run("@papr", "First tweet from TursoSyncBridge test", 99);
  desktop
    .prepare("INSERT INTO job_runs (id, started_at) VALUES (?, ?)")
    .run(1, new Date().toISOString());
  desktop.pragma("wal_checkpoint(TRUNCATE)");
  desktop.close();
  log("   Wrote 1 tweet + 1 job_runs row (scratch should not sync)\n");

  log("2. TursoSyncBridge.pushJob()...");
  const push1 = await bridge.pushJob(jobId);
  log(`   ${JSON.stringify(push1)}\n`);
  if (push1.status !== "pushed" || !push1.tables.includes("tweets")) {
    console.error("❌ FAIL: push did not upload tweets table\n");
    process.exit(1);
  }
  if (push1.tables.includes("job_runs")) {
    console.error("❌ FAIL: push uploaded scratch table job_runs\n");
    process.exit(1);
  }

  log("3. Cloud pull into fresh file (user DB, prefixed tables)...");
  const cloudDb = path.join(os.tmpdir(), `papr-cloud-${jobId}.db`);
  cleanupDb(cloudDb);
  const credentials = await bridge.fetchCredentials("data");
  const core = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js"),
    ).href
  );
  await core.pullTursoToLocalDb(cloudDb, credentials, { jobId });
  const cloudRead = new Database(cloudDb, { readonly: true });
  const cloudRows = cloudRead
    .prepare("SELECT handle, content, likes FROM tweets")
    .all();
  const scratchRows = cloudRead
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'job_runs'",
    )
    .get();
  cloudRead.close();
  log(`   Cloud sees: ${JSON.stringify(cloudRows)}`);
  if (
    cloudRows.length !== 1 ||
    cloudRows[0].content !== "First tweet from TursoSyncBridge test"
  ) {
    console.error("❌ FAIL: cloud did not receive desktop data\n");
    process.exit(1);
  }
  if (scratchRows?.c > 0) {
    console.error("❌ FAIL: cloud received scratch table\n");
    process.exit(1);
  }
  log("   ✅ Cloud received app data only\n");

  log("4. Cloud agent writes new row...");
  const cloudWrite = new Database(cloudDb);
  cloudWrite
    .prepare("INSERT INTO tweets (handle, content, likes) VALUES (?, ?, ?)")
    .run("@cloud", "Written by cloud agent via bridge test", 7);
  cloudWrite.close();
  await core.pushLocalDbToTurso(cloudDb, credentials, { jobId });
  log("   Pushed cloud write\n");

  log("5. TursoSyncBridge.pullJob() back to desktop...");
  cleanupDb(desktopDb);
  const pull = await bridge.pullJob(jobId);
  log(`   ${JSON.stringify(pull)}\n`);
  const desktop2 = new Database(desktopDb, { readonly: true });
  const allTweets = desktop2
    .prepare("SELECT handle, content FROM tweets ORDER BY id")
    .all();
  desktop2.close();
  log(`   Desktop sees: ${JSON.stringify(allTweets)}`);

  if (allTweets.length !== 2 || allTweets[1].handle !== "@cloud") {
    console.error("❌ FAIL: desktop did not receive cloud write\n");
    process.exit(1);
  }

  cleanupDb(cloudDb);
  fs.rmSync(jobRoot, { recursive: true, force: true });
  fs.rmSync(appsRoot, { recursive: true, force: true });

  log("\n✅ TursoSyncBridge TypeScript E2E passed!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
