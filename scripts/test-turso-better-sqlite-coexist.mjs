#!/usr/bin/env node
/**
 * Test: can libsql sync a SQLite file while better-sqlite3 holds it open?
 *
 * This validates the "background sync worker" approach for Phase 3B:
 * - Gateway keeps better-sqlite3 for reads/writes
 * - TursoSyncService uses libsql only for short sync windows
 *
 * Usage:
 *   node scripts/test-turso-better-sqlite-coexist.mjs
 *
 * Requires:
 *   - Memory server on localhost:5001
 *   - PAPR_API_KEY in .env.local or env
 *   - Python venv at ../memory/.venv with libsql_experimental
 */

import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { requirePaprApiKey } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MEMORY_SERVER = process.env.PAPR_MEMORY_SERVER_URL ?? "http://localhost:5001";
const API_KEY = requirePaprApiKey();

const PYTHON = path.join(__dirname, "../../memory/.venv/bin/python3");
const TEST_DB = path.join(os.tmpdir(), `papr-turso-coexist-${Date.now()}.db`);

function log(msg) {
  console.log(msg);
}

function pass(name) {
  console.log(`  ✅ ${name}`);
}

function fail(name, err) {
  console.log(`  ❌ ${name}: ${err}`);
}

async function fetchTursoToken(dbName) {
  const res = await fetch(`${MEMORY_SERVER}/v1/cloud/databases/token`, {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ database: dbName }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  return res.json();
}

function runLibsqlSync(dbPath, syncUrl, authToken, direction = "both") {
  const script = `
import sys
import libsql_experimental as libsql

db_path, sync_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
conn = libsql.connect(db_path, sync_url=sync_url, auth_token=token)
conn.sync()
conn.close()
print("SYNC_OK")
`;
  try {
    const out = execFileSync(PYTHON, ["-c", script, dbPath, syncUrl, authToken], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return out.trim();
  } catch (err) {
    const stderr = err.stderr?.toString() ?? err.message;
    throw new Error(stderr);
  }
}

function setupLocalDb(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function main() {
  log("\n=== Turso + better-sqlite3 Coexistence Test ===\n");

  if (!fs.existsSync(PYTHON)) {
    fail("Prerequisites", `Python venv not found at ${PYTHON}`);
    process.exit(1);
  }

  // Health check memory server
  try {
    const health = await fetch(`${MEMORY_SERVER}/v1/cloud/databases/list`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY },
    });
    if (!health.ok) {
      throw new Error(`HTTP ${health.status}`);
    }
    pass("Memory server reachable");
  } catch (err) {
    fail("Memory server reachable", err.message);
    process.exit(1);
  }

  const dbName = `coexist-test-${Date.now().toString(36)}`;
  log(`\nProvisioning Turso DB: ${dbName}`);
  const { tursoUrl, authToken } = await fetchTursoToken(dbName);
  log(`  URL: ${tursoUrl}`);
  pass("Turso token obtained");

  let passed = 0;
  let failed = 0;

  // ── Test 1: Pull before better-sqlite3 opens (startup pattern) ──
  log("\n--- Test 1: Pull on startup (libsql before better-sqlite3) ---");
  try {
    fs.mkdirSync(path.dirname(TEST_DB), { recursive: true });
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

    runLibsqlSync(TEST_DB, tursoUrl, authToken);
    const db = new Database(TEST_DB);
    setupLocalDb(db);
    db.close();
    pass("Pull on empty local file works");
    passed++;
  } catch (err) {
    fail("Pull on startup", err.message);
    failed++;
  }

  // ── Test 2: better-sqlite3 writes, then sync while connection OPEN ──
  log("\n--- Test 2: Sync while better-sqlite3 connection is OPEN ---");
  try {
    const db = new Database(TEST_DB);
    setupLocalDb(db);
    db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run(
      "user",
      "Hello from better-sqlite3 while open",
    );

    const countBefore = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
    runLibsqlSync(TEST_DB, tursoUrl, authToken);

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
    if (countAfter !== countBefore) {
      throw new Error(`Row count changed during sync: ${countBefore} → ${countAfter}`);
    }
    db.close();
    pass(`Sync while open succeeded (${countAfter} rows intact)`);
    passed++;
  } catch (err) {
    fail("Sync while open", err.message);
    failed++;
  }

  // ── Test 3: WAL checkpoint + sync while open ──
  log("\n--- Test 3: WAL checkpoint(PASSIVE) then sync while open ---");
  try {
    const db = new Database(TEST_DB);
    setupLocalDb(db);
    db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run(
      "user",
      "After checkpoint test",
    );
    db.pragma("wal_checkpoint(PASSIVE)");

    runLibsqlSync(TEST_DB, tursoUrl, authToken);
    db.close();
    pass("Checkpoint + sync while open succeeded");
    passed++;
  } catch (err) {
    fail("Checkpoint + sync while open", err.message);
    failed++;
  }

  // ── Test 4: Remote round-trip — write local, push, read from fresh connection ──
  log("\n--- Test 4: Round-trip — local write → push → pull on new device ---");
  try {
    const db = new Database(TEST_DB);
    setupLocalDb(db);
    const marker = `marker-${Date.now()}`;
    db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run("user", marker);
    db.pragma("wal_checkpoint(PASSIVE)");
    db.close();

    runLibsqlSync(TEST_DB, tursoUrl, authToken);

    const remoteDb = path.join(os.tmpdir(), `papr-turso-remote-${Date.now()}.db`);
    runLibsqlSync(remoteDb, tursoUrl, authToken);

    const reader = new Database(remoteDb, { readonly: true });
    const row = reader
      .prepare("SELECT content FROM messages WHERE content = ?")
      .get(marker);
    reader.close();
    fs.unlinkSync(remoteDb);

    if (!row) throw new Error(`Marker "${marker}" not found after cloud round-trip`);
    pass(`Round-trip verified (found "${marker}")`);
    passed++;
  } catch (err) {
    fail("Round-trip", err.message);
    failed++;
  }

  // ── Test 5: Job simulation — short-lived second connection + sync retry ──
  log("\n--- Test 5: Job simulation — gateway open + job writes + sync ---");
  try {
    const gateway = new Database(TEST_DB);
    setupLocalDb(gateway);

    // Simulate job: open, write, close quickly
    const jobDb = new Database(TEST_DB);
    jobDb.pragma("busy_timeout = 5000");
    jobDb
      .prepare("INSERT INTO messages (role, content) VALUES (?, ?)")
      .run("assistant", "Written by simulated job process");
    jobDb.close();

    gateway.pragma("wal_checkpoint(PASSIVE)");
    runLibsqlSync(TEST_DB, tursoUrl, authToken);
    gateway.close();
    pass("Gateway open + job write + sync succeeded");
    passed++;
  } catch (err) {
    fail("Job simulation", err.message);
    failed++;
  }

  // ── Test 6: Pull while better-sqlite3 is open (periodic pull pattern) ──
  log("\n--- Test 6: Pull from cloud while better-sqlite3 is open ---");
  try {
    // Write to cloud from a separate local file first
    const cloudWriter = path.join(os.tmpdir(), `papr-turso-writer-${Date.now()}.db`);
    runLibsqlSync(cloudWriter, tursoUrl, authToken);
    const writer = new Database(cloudWriter);
    setupLocalDb(writer);
    const remoteMarker = `remote-${Date.now()}`;
    writer
      .prepare("INSERT INTO messages (role, content) VALUES (?, ?)")
      .run("user", remoteMarker);
    writer.close();
    runLibsqlSync(cloudWriter, tursoUrl, authToken);
    fs.unlinkSync(cloudWriter);

    // Gateway has DB open — try pull
    const gateway = new Database(TEST_DB);
    setupLocalDb(gateway);
    runLibsqlSync(TEST_DB, tursoUrl, authToken);

    const found = gateway
      .prepare("SELECT content FROM messages WHERE content = ?")
      .get(remoteMarker);
    gateway.close();

    if (!found) throw new Error(`Remote marker "${remoteMarker}" not pulled while open`);
    pass(`Pull while open succeeded (found "${remoteMarker}")`);
    passed++;
  } catch (err) {
    fail("Pull while open", err.message);
    failed++;
  }

  // Cleanup
  try {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
    if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);
  } catch {
    // ignore cleanup errors
  }

  log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    log("⚠️  Some tests failed — background sync worker may need:");
    log("   - Sync only when idle / after job completes");
    log("   - Close better-sqlite3 briefly during sync windows");
    log("   - Or pull-only on startup, push-only with checkpoint\n");
    process.exit(1);
  }

  log("✅ All tests passed — background sync worker approach is viable!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
