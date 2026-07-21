#!/usr/bin/env node
/**
 * Changelog CDC sync tests (local + optional live Turso).
 *
 * Local section runs without network. Live section needs memory server + Turso.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-turso-delta-sync.mjs
 *
 * Env:
 *   PAPR_MEMORY_SERVER_URL — default http://localhost:5001 (live section)
 *   PAPR_API_KEY — required for live Turso delta push/pull
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed += 1;
}

function fail(label, detail) {
  console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
}

function skip(label, reason) {
  console.log(`  ⏭️  ${label} — ${reason}`);
  skipped += 1;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
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

async function loadModules() {
  const logMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncLog.js")).href
  );
  const coreMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js")).href
  );
  const stateMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncState.js")).href
  );
  return { logMod, coreMod, stateMod };
}

section("1. Local changelog CDC (no network)");
{
  const {
    ensureLocalTableSyncTriggers,
    readSyncLogSince,
    withSyncMuted,
    pruneSyncLogThrough,
    maxSyncLogId,
  } = await loadModules().then((m) => m.logMod);

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    );
  `);
  ensureLocalTableSyncTriggers(db, "records");
  db.prepare("INSERT INTO records (label) VALUES (?)").run("one");
  db.prepare("UPDATE records SET label = ? WHERE id = 1").run("two");
  const entries = readSyncLogSince(db, 0);
  if (entries.length === 2 && entries[0].op === "insert" && entries[1].op === "update") {
    ok("insert + update produce two changelog entries");
  } else {
    fail("insert + update changelog", JSON.stringify(entries));
  }

  withSyncMuted(db, () => {
    db.prepare("INSERT INTO records (label) VALUES (?)").run("muted");
  });
  const afterMute = readSyncLogSince(db, entries[entries.length - 1].id);
  if (afterMute.length === 0) {
    ok("withSyncMuted suppresses echo during apply");
  } else {
    fail("withSyncMuted", `expected 0 entries, got ${afterMute.length}`);
  }

  db.exec(`
    CREATE TABLE big_data (id INTEGER PRIMARY KEY, value TEXT);
  `);
  ensureLocalTableSyncTriggers(db, "big_data");
  const ins = db.prepare("INSERT INTO big_data (id, value) VALUES (?, ?)");
  const tx = db.transaction((n) => {
    for (let i = 1; i <= n; i += 1) ins.run(i, `v${i}`);
  });
  tx(2500);
  const bulkEnd = maxSyncLogId(db);
  db.prepare("UPDATE big_data SET value = ? WHERE id = 2500").run("delta");
  const delta = readSyncLogSince(db, bulkEnd);
  if (delta.length === 1 && delta[0].op === "update" && JSON.stringify(delta[0].rowPk) === "[2500]") {
    ok("2500-row table: single update → 1 changelog entry (not full rewrite)");
  } else {
    fail("large table delta log", JSON.stringify(delta));
  }

  pruneSyncLogThrough(db, maxSyncLogId(db));
  if (readSyncLogSince(db, 0).length === 0) {
    ok("pruneSyncLogThrough clears applied entries");
  } else {
    fail("pruneSyncLogThrough");
  }
  db.close();
}

section("2. Compiled CDC symbols present");
{
  const coreSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js"),
    "utf8",
  );
  const logSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoSyncLog.js"),
    "utf8",
  );
  const deltaSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoDeltaSync.js"),
    "utf8",
  );

  if (logSrc.includes("_papr_sync_log") && logSrc.includes("_papr_tr_")) {
    ok("sync log + trigger infrastructure compiled");
  } else fail("sync log infrastructure missing");

  if (deltaSrc.includes("pushDeltaToRemote") && deltaSrc.includes("applyRemoteSyncLogToLocal")) {
    ok("delta push/pull helpers compiled");
  } else fail("delta sync helpers missing");

  if (coreSrc.includes('syncMode: "delta"') && coreSrc.includes("lastPushedLogId")) {
    ok("bridge core returns delta mode + log cursors");
  } else fail("bridge core delta wiring missing");

  const stateSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoSyncState.js"),
    "utf8",
  );
  if (stateSrc.includes("lastPulledLogId") && stateSrc.includes("lastPushedLogId")) {
    ok("sync state persists log cursors");
  } else fail("sync state log cursors missing");
}

section("3. Live Turso delta E2E (optional)");
{
  const memoryBase = (process.env.PAPR_MEMORY_SERVER_URL ?? "http://localhost:5001").replace(
    /\/$/,
    "",
  );
  const apiKey = process.env.PAPR_API_KEY;

  const health = await fetch(`${memoryBase}/health`).catch(() => null);
  if (!health?.ok) {
    skip("live Turso delta E2E", `memory server not reachable at ${memoryBase}`);
  } else if (!apiKey) {
    skip("live Turso delta E2E", "set PAPR_API_KEY");
  } else {
    const { coreMod } = await loadModules();
    const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-delta-"));
    const jobId = `delta-${Date.now().toString(36)}`;
    const dbPath = path.join(jobRoot, jobId, "data", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    cleanupDb(dbPath);

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE metrics (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        value REAL NOT NULL
      );
    `);
    const insert = db.prepare("INSERT INTO metrics (id, name, value) VALUES (?, ?, ?)");
    const tx = db.transaction((n) => {
      for (let i = 1; i <= n; i += 1) insert.run(i, `metric-${i}`, i);
    });
    tx(2100);
    db.close();

    const databaseName = `j-${jobId.slice(0, 8)}`;
    const tokenResp = await fetch(`${memoryBase}/v1/cloud/databases/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ database: databaseName }),
    });
    if (!tokenResp.ok) {
      fail("Turso token", `${tokenResp.status} ${(await tokenResp.text()).slice(0, 120)}`);
    } else {
      const creds = await tokenResp.json();
      const push1 = await coreMod.pushLocalDbToTurso(dbPath, creds, { jobId });
      if (push1.status === "pushed" && push1.syncMode === "bootstrap") {
        ok(`bootstrap push uploaded ${push1.tables.length} table(s)`);
      } else {
        fail("bootstrap push", JSON.stringify(push1));
      }

      const db2 = new Database(dbPath);
      db2.prepare("UPDATE metrics SET value = ? WHERE id = 2100").run(999);
      db2.close();

      const push2 = await coreMod.pushLocalDbToTurso(dbPath, creds, {
        jobId,
        lastPushedLogId: push1.lastPushedLogId ?? 0,
        previousFingerprints: push1.tableFingerprints,
      });
      if (
        push2.status === "pushed" &&
        push2.syncMode === "delta" &&
        push2.deltaEntries === 1
      ) {
        ok("delta push after 2100-row table + 1 update (1 changelog entry)");
      } else {
        fail("delta push", JSON.stringify(push2));
      }

      const pullDb = path.join(os.tmpdir(), `papr-delta-pull-${jobId}.db`);
      cleanupDb(pullDb);
      const pull = await coreMod.pullTursoToLocalDb(pullDb, creds, {
        jobId,
        lastPulledLogId: 0,
        force: true,
      });
      if (pull.status === "pulled") {
        const pulled = new Database(pullDb, { readonly: true });
        const row = pulled.prepare("SELECT value FROM metrics WHERE id = 2100").get();
        pulled.close();
        if (row?.value === 999) {
          ok("pull round-trip preserved single-row delta (value=999)");
        } else {
          fail("pull value", JSON.stringify(row));
        }
      } else {
        fail("pull", JSON.stringify(pull));
      }
      cleanupDb(pullDb);
    }

    fs.rmSync(jobRoot, { recursive: true, force: true });
  }
}

section("Summary");
console.log(`Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
process.exit(failed > 0 ? 1 : 0);
