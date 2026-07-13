#!/usr/bin/env node
/**
 * Test job data.db → Turso boundary sync (the actual 3B approach).
 *
 * Flow:
 *   1. Desktop: better-sqlite3 writes job data.db (simulated job)
 *   2. Push:    read tables → upsert to Turso via libsql remote
 *   3. Cloud:   libsql pull into fresh file → better-sqlite3 reads
 *   4. Cloud:   better-sqlite3 writes new row
 *   5. Push:    bridge again
 *   6. Desktop: libsql pull → better-sqlite3 sees cloud changes
 */

import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { requirePaprApiKey } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = path.join(__dirname, "../../memory/.venv/bin/python3");
const MEMORY_SERVER = process.env.PAPR_MEMORY_SERVER_URL ?? "http://localhost:5001";
const API_KEY = requirePaprApiKey();

const BRIDGE_PY = `
import json, sqlite3, sys
import libsql_experimental as libsql

local_path, turso_url, token, staging_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

# Read all user tables from local SQLite (written by better-sqlite3 / job code)
conn = sqlite3.connect(local_path)
tables = [
    r[0]
    for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'"
    ).fetchall()
]

# Use a staging replica file (not :memory:) for reliable push
remote = libsql.connect(staging_path, sync_url=turso_url, auth_token=token)
remote.sync()  # pull current cloud state first

for table in tables:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if not cols:
        continue
    col_defs = ", ".join(
        f"{c[1]} {c[2] or 'TEXT'}" + (" PRIMARY KEY" if c[5] else "")
        for c in cols
    )
    remote.execute(f"DROP TABLE IF EXISTS {table}")
    remote.execute(f"CREATE TABLE {table} ({col_defs})")
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    if not rows:
        continue
    placeholders = ", ".join("?" * len(cols))
    col_names = ", ".join(c[1] for c in cols)
    for row in rows:
        remote.execute(
            f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
            row,
        )
    remote.commit()

remote.sync()
remote.close()
conn.close()
print(json.dumps({"tables": tables, "status": "pushed"}))
`;

const PULL_PY = `
import sys
import libsql_experimental as libsql

local_path, turso_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
conn = libsql.connect(local_path, sync_url=turso_url, auth_token=token)
conn.sync()
conn.close()
print("PULL_OK")
`;

function log(msg) {
  console.log(msg);
}

function runPy(script, args) {
  return execFileSync(PYTHON, ["-c", script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  }).trim();
}

function cleanup(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore
    }
  }
}

function setupJobDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL,
      content TEXT NOT NULL,
      likes INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
  `);
  db.close();
}

async function fetchToken(dbName) {
  const res = await fetch(`${MEMORY_SERVER}/v1/cloud/databases/token`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ database: dbName }),
  });
  if (!res.ok) throw new Error(`Token failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  log("\n=== Job data.db → Turso Boundary Sync Test ===\n");

  if (!fs.existsSync(PYTHON)) {
    console.error("Missing memory server Python venv:", PYTHON);
    process.exit(1);
  }

  const dbName = `job-sync-test-${Date.now().toString(36)}`;
  const { tursoUrl, authToken } = await fetchToken(dbName);
  log(`Turso DB: ${dbName}`);
  log(`URL: ${tursoUrl}\n`);

  const desktopDb = path.join(os.tmpdir(), `papr-job-desktop-${Date.now()}.db`);
  const cloudDb = path.join(os.tmpdir(), `papr-job-cloud-${Date.now()}.db`);
  const desktop2Db = path.join(os.tmpdir(), `papr-job-desktop2-${Date.now()}.db`);
  cleanup(desktopDb);
  cleanup(cloudDb);
  cleanup(desktop2Db);

  // Step 1: Simulate local job writing data
  log("1. Desktop job writes to data.db (better-sqlite3)...");
  setupJobDb(desktopDb);
  const desktop = new Database(desktopDb);
  desktop
    .prepare("INSERT INTO tweets (handle, content, likes) VALUES (?, ?, ?)")
    .run("@papr", "First tweet from desktop job", 42);
  desktop
    .prepare("INSERT INTO job_runs (id, status, started_at) VALUES (?, ?, datetime('now'))")
    .run("run-001", "completed");
  const desktopCount = desktop.prepare("SELECT COUNT(*) as c FROM tweets").get().c;
  desktop.pragma("wal_checkpoint(TRUNCATE)");
  desktop.close();
  log(`   Wrote ${desktopCount} tweet(s) + 1 job_run\n`);

  const stagingDb = path.join(os.tmpdir(), `papr-job-staging-${Date.now()}.db`);
  cleanup(stagingDb);

  // Step 2: Push bridge → Turso
  log("2. Push bridge (read sqlite → libsql remote)...");
  const pushResult = runPy(BRIDGE_PY, [desktopDb, tursoUrl, authToken, stagingDb]);
  log(`   ${pushResult}\n`);

  // Step 3: Cloud hydrates and reads
  log("3. Cloud sandbox pulls Turso → local file...");
  runPy(PULL_PY, [cloudDb, tursoUrl, authToken]);
  const cloud = new Database(cloudDb, { readonly: true });
  const cloudTweets = cloud.prepare("SELECT handle, content, likes FROM tweets").all();
  const cloudRuns = cloud.prepare("SELECT id, status FROM job_runs").all();
  cloud.close();
  log(`   Cloud sees tweets: ${JSON.stringify(cloudTweets)}`);
  log(`   Cloud sees job_runs: ${JSON.stringify(cloudRuns)}`);

  if (cloudTweets.length !== 1 || cloudTweets[0].content !== "First tweet from desktop job") {
    console.error("\n❌ FAIL: Cloud did not receive desktop job data\n");
    process.exit(1);
  }
  log("   ✅ Cloud received desktop data\n");

  // Step 4: Cloud agent/job writes
  log("4. Cloud agent writes new row (better-sqlite3)...");
  const cloudWrite = new Database(cloudDb);
  cloudWrite
    .prepare("INSERT INTO tweets (handle, content, likes) VALUES (?, ?, ?)")
    .run("@cloud-agent", "Written by cloud agent", 7);
  cloudWrite.close();
  log("   Cloud agent inserted 1 tweet\n");

  // Step 5: Push bridge from cloud → Turso
  log("5. Push bridge from cloud → Turso...");
  const staging2 = path.join(os.tmpdir(), `papr-job-staging2-${Date.now()}.db`);
  cleanup(staging2);
  runPy(BRIDGE_PY, [cloudDb, tursoUrl, authToken, staging2]);
  log("   Pushed\n");

  // Step 6: Desktop pulls back
  log("6. Desktop pulls Turso → new local file...");
  runPy(PULL_PY, [desktop2Db, tursoUrl, authToken]);
  const desktop2 = new Database(desktop2Db, { readonly: true });
  const allTweets = desktop2.prepare("SELECT handle, content FROM tweets ORDER BY id").all();
  desktop2.close();
  log(`   Desktop sees: ${JSON.stringify(allTweets)}`);

  if (allTweets.length !== 2) {
    console.error(`\n❌ FAIL: Expected 2 tweets, got ${allTweets.length}\n`);
    process.exit(1);
  }
  if (allTweets[1].handle !== "@cloud-agent") {
    console.error("\n❌ FAIL: Cloud agent write not visible on desktop\n");
    process.exit(1);
  }

  cleanup(desktopDb);
  cleanup(cloudDb);
  cleanup(desktop2Db);

  log("\n✅ Job boundary sync works end-to-end!");
  log("   Desktop job (better-sqlite3) → Turso → Cloud agent → Turso → Desktop\n");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
