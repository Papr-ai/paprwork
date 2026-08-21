#!/usr/bin/env node
/**
 * Phase 1.1 E2E — oplog-only routine path (no silent 2K/25K bootstrap heuristics).
 *
 * Uses a throwaway Turso database (NOT Joe Coffee / production apps).
 *
 * Validates:
 *   1. Large table (>2K rows) + small update → delta push (not bootstrap)
 *   2. Large oplog backlog (>25K entries) → delta replay (not full bootstrap)
 *   3. Both desktop core (pushLocalDbToTurso) and sandbox (pushLinkedSourceToCloud)
 *
 * Prerequisites:
 *   npm run build:gateway
 *   PAPR_API_KEY ( .env.local, keychain, or gateway proxy )
 *   Memory server reachable
 *
 * Usage:
 *   npm run test:turso-phase1-oplog-e2e
 */

import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvLocal, resolveMemoryAccess } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

// Match cloud agent sandbox — avoid desktop workspace pointer overriding temp PAPR_HOME
process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";

let passed = 0;
let failed = 0;
let skipped = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

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

function formatMs(ms) {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  console.log(`  ⏱️  ${label}: ${formatMs(elapsed)}`);
  return { result, elapsed };
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
  const coreMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js")).href
  );
  const logMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncLog.js")).href
  );
  const stateMod = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncState.js")).href
  );
  const bookendsMod = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/cloudAgentGateway/syncJobTursoBookends.js"),
    ).href
  );
  return { coreMod, logMod, stateMod, bookendsMod };
}

function seedLargeTable(dbPath, rowCount, logMod) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  cleanupDb(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      payload TEXT
    );
  `);
  logMod.ensureLocalTableSyncTriggers(db, "events");
  const insert = db.prepare("INSERT INTO events (id, label, payload) VALUES (?, ?, ?)");
  const tx = db.transaction((n) => {
    for (let i = 1; i <= n; i += 1) {
      insert.run(i, `event-${i}`, `payload-${i}`);
    }
  });
  tx(rowCount);
  db.close();
}

async function fetchTursoCreds(memoryAccess, database) {
  const tokenUrl =
    memoryAccess.mode === "gateway"
      ? `${memoryAccess.cloudBase}/databases/token`
      : `${memoryAccess.memoryBase}/v1/cloud/databases/token`;
  const headers = { "Content-Type": "application/json" };
  if (memoryAccess.mode === "direct") {
    headers["X-API-Key"] = memoryAccess.apiKey;
  }
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ database }),
  });
  if (!res.ok) {
    throw new Error(`token ${database}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return {
    tursoUrl: body.tursoUrl ?? body.url,
    authToken: body.authToken ?? body.token,
  };
}

async function remoteRowCount(creds, tableName) {
  const client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  try {
    const result = await client.execute(`SELECT COUNT(*) AS c FROM ${tableName}`);
    return Number(result.rows[0]?.c ?? 0);
  } finally {
    client.close();
  }
}

section("1. Compiled Phase 1.1 guards (no network)");
{
  const coreSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js"),
    "utf8",
  );
  const bulkSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoBulkInsert.js"),
    "utf8",
  );
  const deltaPushSrc = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoDeltaPush.js"),
    "utf8",
  );

  if (
    coreSrc.includes("explicit repair or empty remote") &&
    !coreSrc.includes("pendingLogCount > LOCAL_LOG_BOOTSTRAP_THRESHOLD")
  ) {
    ok("bootstrap no longer triggered by 25K oplog threshold");
  } else {
    fail("25K bootstrap guard", "expected oplog-only bootstrap condition in dist");
  }

  if (bulkSrc.includes("REMOTE_INSERT_CHUNK_ROWS") && bulkSrc.includes("500")) {
    ok("chunked multi-row insert module present (500 rows/statement)");
  } else {
    fail("tursoBulkInsert", "chunked insert module missing");
  }

  if (!coreSrc.includes("localPks.length <= 2_000") && !coreSrc.includes("localPks.length <= 2000")) {
    ok("removed >2K rows → DROP TABLE heuristic");
  } else {
    fail("2K DROP heuristic", "still present in compiled bridge core");
  }

  if (
    deltaPushSrc.includes("batchInsertLocalTableRows") &&
    deltaPushSrc.includes("compactSyncLogEntries")
  ) {
    ok("batched delta push module present (tursoDeltaPush.js)");
  } else {
    fail("batched delta push", "tursoDeltaPush.js missing batch/compaction");
  }
}

section("2. Live Turso — desktop path (pushLocalDbToTurso)");
{
  const memoryAccess = await resolveMemoryAccess();
  if (!memoryAccess) {
    skip("desktop path live E2E", "no PAPR_API_KEY / memory access");
  } else {
    const { coreMod, logMod } = await loadModules();
    const syncKey = `p1-desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const root = path.join(os.tmpdir(), syncKey);
    const dbPath = path.join(root, "data.db");
    const databaseName = `j-${syncKey.replace(/-/g, "").slice(0, 20)}`;

    try {
      const seedStart = performance.now();
      seedLargeTable(dbPath, 2600, logMod);
      console.log(`  ⏱️  seed 2600 local rows: ${formatMs(performance.now() - seedStart)}`);

      const { result: creds, elapsed: tokenMs } = await timed("memory server token fetch", () =>
        fetchTursoCreds(memoryAccess, databaseName),
      );

      const { result: push1, elapsed: bootstrapMs } = await timed(
        "push1 bootstrap (2600 rows)",
        () => coreMod.pushLocalDbToTurso(dbPath, creds, { jobId: syncKey }),
      );
      if (push1.status === "pushed" && (push1.syncMode === "bootstrap" || push1.syncMode === "delta")) {
        ok(
          `desktop: first push → ${push1.syncMode} (${push1.deltaEntries ?? push1.tables.length} entries, ${formatMs(bootstrapMs)})`,
        );
      } else {
        fail("desktop first push", JSON.stringify(push1));
      }

      const remoteCount1 = await remoteRowCount(creds, "events");
      if (remoteCount1 >= 2600) {
        ok(`desktop: remote has ${remoteCount1} rows after first push (expected ≥2600)`);
      } else {
        fail("desktop remote row count after first push", String(remoteCount1));
      }

      const db = new Database(dbPath);
      db.prepare("UPDATE events SET label = ? WHERE id = 2600").run("updated-desktop");
      db.close();

      const { result: push2, elapsed: deltaSmallMs } = await timed(
        "push2 delta (1 update)",
        () =>
          coreMod.pushLocalDbToTurso(dbPath, creds, {
            jobId: syncKey,
            lastPushedLogId: push1.lastPushedLogId ?? 0,
            previousFingerprints: push1.tableFingerprints,
          }),
      );
      if (push2.status === "pushed" && push2.syncMode === "delta" && push2.deltaEntries === 1) {
        ok(`desktop: 1-row delta in ${formatMs(deltaSmallMs)}`);
      } else {
        fail("desktop delta after large table", JSON.stringify(push2));
      }

      // Inflate oplog beyond old 25K bootstrap threshold
      const bulkSeedStart = performance.now();
      const dbBulk = new Database(dbPath);
      logMod.ensureLocalTableSyncTriggers(dbBulk, "events");
      const ins = dbBulk.prepare("INSERT INTO events (id, label, payload) VALUES (?, ?, ?)");
      const tx = dbBulk.transaction((start, count) => {
        for (let i = 0; i < count; i += 1) {
          ins.run(start + i, `bulk-${start + i}`, "x");
        }
      });
      tx(26001, 26000);
      dbBulk.close();
      console.log(`  ⏱️  seed 26000 local oplog entries: ${formatMs(performance.now() - bulkSeedStart)}`);

      const pending = logMod.countSyncLogSince(new Database(dbPath), push2.lastPushedLogId ?? 0);
      if (pending >= 25_000) {
        ok(`desktop: ${pending} pending oplog entries (>25K old threshold)`);
      } else {
        fail("oplog backlog size", String(pending));
      }

      const { result: push3, elapsed: bulkDeltaMs } = await timed(
        `push3 batched delta (${pending} oplog entries)`,
        () =>
          coreMod.pushLocalDbToTurso(dbPath, creds, {
            jobId: syncKey,
            lastPushedLogId: push2.lastPushedLogId ?? 0,
            previousFingerprints: push2.tableFingerprints,
          }),
      );
      if (push3.status === "pushed" && push3.syncMode === "delta") {
        const rowsPerSec = Math.round((push3.deltaEntries ?? pending) / (bulkDeltaMs / 1000));
        ok(
          `desktop: ${push3.deltaEntries ?? pending} entries via batched delta in ${formatMs(bulkDeltaMs)} (~${rowsPerSec} rows/s)`,
        );
        console.log(
          `  📊 Old row-by-row estimate: ~${formatMs(bulkDeltaMs * 80)}+ (≈80× slower, 2 HTTP calls/row)`,
        );
      } else {
        fail("desktop large oplog push", JSON.stringify(push3));
      }

      const remoteCount2 = await remoteRowCount(creds, "events");
      const expected = 2600 + 26000;
      if (remoteCount2 === expected) {
        ok(`desktop: remote row count ${expected} after large oplog push`);
      } else {
        fail("desktop final remote count", `expected ${expected}, got ${remoteCount2}`);
      }
    } catch (error) {
      fail("desktop path live E2E", error instanceof Error ? error.message : String(error));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

section("3. Live Turso — sandbox path (pushLinkedSourceToCloud)");
{
  const memoryAccess = await resolveMemoryAccess();
  if (!memoryAccess) {
    skip("sandbox path live E2E", "no PAPR_API_KEY / memory access");
  } else {
    const { bookendsMod, logMod, stateMod } = await loadModules();
    const syncKey = `p1-sandbox-${Date.now().toString(36)}`;
    const root = path.join(os.tmpdir(), syncKey);
    const paprHome = path.join(root, "Papr");
    const dbPath = path.join(root, "Jobs", syncKey, "data", "data.db");
    const databaseName = `j-${syncKey.slice(0, 12).replace(/-/g, "")}`;

    process.env.PAPR_HOME = paprHome;

    try {
      seedLargeTable(dbPath, 2100, logMod);
      const creds = await fetchTursoCreds(memoryAccess, databaseName);
      const target = { syncKey, dbPath, tursoUrl: creds.tursoUrl, authToken: creds.authToken };

      const push1 = await bookendsMod.pushLinkedSourceToCloud(target);
      if (push1.status === "pushed" && (push1.syncMode === "bootstrap" || push1.syncMode === "delta")) {
        ok(`sandbox: first push → ${push1.syncMode ?? "unknown"}`);
      } else {
        fail("sandbox first push", JSON.stringify(push1));
      }

      stateMod.recordTursoPushSuccess(
        syncKey,
        dbPath,
        paprHome,
        push1.lastPushedLogId,
      );

      const db = new Database(dbPath);
      db.prepare("UPDATE events SET label = ? WHERE id = 2100").run("updated-sandbox");
      db.close();

      const push2 = await bookendsMod.pushLinkedSourceToCloud(target);
      if (push2.status === "pushed" && push2.syncMode === "delta" && (push2.deltaEntries ?? 0) <= 5) {
        ok("sandbox: 2100-row table + update → delta via pushLinkedSourceToCloud");
      } else if (push2.status === "pushed" && push2.syncMode === "delta") {
        ok(`sandbox: delta push (${push2.deltaEntries ?? "?"} entries)`);
      } else {
        fail("sandbox delta push", JSON.stringify(push2));
      }

      const remoteCount = await remoteRowCount(creds, "events");
      if (remoteCount === 2100) {
        ok("sandbox: remote row count preserved (2100)");
      } else {
        fail("sandbox remote count", String(remoteCount));
      }
    } catch (error) {
      fail("sandbox path live E2E", error instanceof Error ? error.message : String(error));
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

section("Summary");
console.log(`\nPassed: ${passed}  Failed: ${failed}  Skipped: ${skipped}\n`);
process.exit(failed > 0 ? 1 : 0);
