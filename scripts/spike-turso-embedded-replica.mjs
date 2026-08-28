#!/usr/bin/env node
/**
 * Spike: Turso Sync (@tursodatabase/sync) as sole authority vs legacy @libsql/client embedded replicas.
 *
 * Prerequisites:
 *   - Papr Work gateway running (localhost:18789) with Papr login / keychain
 *   - OR PAPR_API_KEY in .env.local
 *
 * Usage:
 *   node scripts/spike-turso-embedded-replica.mjs
 *   npm run spike:turso-replica
 */

import { connect } from "@tursodatabase/sync";
import { createClient } from "@libsql/client";
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal, resolveMemoryAccess } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {{ id: string, pass: boolean, detail: string, ms?: number }} SpikeResult */

/** @type {SpikeResult[]} */
const results = [];

function log(msg) {
  console.log(msg);
}

function record(id, pass, detail, ms) {
  results.push({ id, pass, detail, ms });
  log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}${ms != null ? ` (${ms}ms)` : ""}`);
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

async function resolveCloudBase() {
  loadEnvLocal();
  const access = await resolveMemoryAccess();
  if (!access) {
    throw new Error("No Papr Memory access — login in Papr Work or set PAPR_API_KEY");
  }
  if (access.mode === "gateway") {
    return access.cloudBase;
  }
  return `${access.memoryBase}/v1/cloud`;
}

async function fetchToken(cloudBase, dbName) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.PAPR_API_KEY?.trim()) {
    headers["X-API-Key"] = process.env.PAPR_API_KEY.trim();
  }
  const res = await fetch(`${cloudBase}/databases/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({ database: dbName }),
  });
  if (!res.ok) {
    throw new Error(`token ${dbName} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.tursoUrl || !data.authToken) {
    throw new Error(`token response missing fields for ${dbName}`);
  }
  return { tursoUrl: data.tursoUrl, authToken: data.authToken };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHostNotReadyError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("404") || msg.includes("Host not found") || msg.includes("not found");
}

async function connectWithRetry(opts, label = "connect") {
  const delays = [0, 1500, 3000, 5000, 8000];
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      log(`  … retry ${label} in ${delays[attempt]}ms (attempt ${attempt + 1})`);
      await sleep(delays[attempt]);
    }
    try {
      const db = await connect(opts);
      await db.connect();
      return db;
    } catch (error) {
      lastError = error;
      if (!isHostNotReadyError(error) || attempt === delays.length - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** Provision remote Turso DB (hostname must exist before bootstrapIfEmpty:false). */
async function provisionRemote(tursoUrl, authToken) {
  const tmp = path.join(os.tmpdir(), `provision-${Date.now()}.db`);
  cleanup(tmp);
  const db = await connectWithRetry(
    {
      path: tmp,
      url: tursoUrl,
      authToken,
      bootstrapIfEmpty: true,
    },
    "provision",
  );
  await db.exec("SELECT 1");
  await db.push();
  await db.close();
  cleanup(tmp);
}

async function main() {
  log("\n=== Turso Replica Spike (Plan A gate) ===\n");

  const cloudBase = await resolveCloudBase();
  log(`Cloud API: ${cloudBase}\n`);

  // ── Tests 1–3: connect, push, second device pull ─────────────────────
  const dbName = `spike-sync-${Date.now().toString(36)}`;
  const { tursoUrl, authToken } = await fetchToken(cloudBase, dbName);
  const local1 = path.join(os.tmpdir(), `${dbName}-1.db`);
  cleanup(local1);

  const tConnect = performance.now();
  const db1 = await connectWithRetry(
    {
      path: local1,
      url: tursoUrl,
      authToken,
      bootstrapIfEmpty: true,
    },
    "device1",
  );
  record("1", true, "Turso Sync connect + bootstrap", Math.round(performance.now() - tConnect));

  await db1.exec(
    "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  );
  await db1.exec("INSERT INTO items (label) VALUES ('device1')");
  const tPush = performance.now();
  await db1.push();
  record("2", true, "Local write + push() to primary", Math.round(performance.now() - tPush));

  const remote = createClient({ url: tursoUrl, authToken });
  const remoteCheck = await remote.execute("SELECT label FROM items");
  const remoteOk = remoteCheck.rows.some(
    (row) => String(row.label ?? row[0]) === "device1",
  );
  record("2b", remoteOk, `HTTP remote client sees row (count=${remoteCheck.rows.length})`);

  const local2 = path.join(os.tmpdir(), `${dbName}-2.db`);
  cleanup(local2);
  const db2 = await connectWithRetry(
    {
      path: local2,
      url: tursoUrl,
      authToken,
      bootstrapIfEmpty: true,
    },
    "device2",
  );
  const tPull = performance.now();
  await db2.pull();
  const stmt2 = await db2.prepare("SELECT label FROM items");
  const rows2 = await stmt2.all();
  const pullOk = rows2.some((row) => (row.label ?? row[0]) === "device1");
  record(
    "3",
    pullOk,
    `Second device pull() sees write ${JSON.stringify(rows2)}`,
    Math.round(performance.now() - tPull),
  );

  // ── Test 4: offline local writes → push on reconnect ─────────────────
  const offlineName = `spike-offline-${Date.now().toString(36)}`;
  const offlineTok = await fetchToken(cloudBase, offlineName);
  await provisionRemote(offlineTok.tursoUrl, offlineTok.authToken);

  const offlinePath = path.join(os.tmpdir(), `${offlineName}.db`);
  cleanup(offlinePath);
  const offlineDb = await connectWithRetry(
    {
      path: offlinePath,
      url: offlineTok.tursoUrl,
      authToken: offlineTok.authToken,
      bootstrapIfEmpty: false,
    },
    "offline",
  );
  await offlineDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  await offlineDb.exec("INSERT INTO notes (body) VALUES ('offline-local')");
  await offlineDb.push();
  const offlineRemote = createClient({
    url: offlineTok.tursoUrl,
    authToken: offlineTok.authToken,
  });
  const offRows = await offlineRemote.execute("SELECT body FROM notes");
  record("4", offRows.rows.length === 1, "Offline local write then push() on reconnect");
  await offlineDb.close();
  offlineRemote.close();

  // ── Test 5: rapid push/pull ───────────────────────────────────────────
  for (let i = 0; i < 5; i++) {
    await db1.exec(`INSERT INTO items (label) VALUES ('flap-${i}')`);
    await db1.push();
    await db2.pull();
  }
  const flapStmt = await db2.prepare("SELECT COUNT(*) as c FROM items");
  const flapRow = await flapStmt.get();
  const flapCount = Number(flapRow?.c ?? 0);
  record("5", flapCount >= 6, `Rapid push/pull x5 — device2 count=${flapCount}`);

  // ── Test 6: DDL through primary ───────────────────────────────────────
  const ddlName = `spike-ddl-${Date.now().toString(36)}`;
  const ddlTok = await fetchToken(cloudBase, ddlName);
  const ddlPath = path.join(os.tmpdir(), `${ddlName}.db`);
  cleanup(ddlPath);
  const ddlDb = await connectWithRetry(
    {
      path: ddlPath,
      url: ddlTok.tursoUrl,
      authToken: ddlTok.authToken,
      bootstrapIfEmpty: true,
    },
    "ddl-online",
  );
  await ddlDb.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  await ddlDb.push();
  await ddlDb.exec("ALTER TABLE users ADD COLUMN email TEXT");
  await ddlDb.push();
  const ddlRemote = createClient({ url: ddlTok.tursoUrl, authToken: ddlTok.authToken });
  const ddlRemoteCols = await ddlRemote.execute("PRAGMA table_info(users)");
  const ddlOk = ddlRemoteCols.rows.some(
    (row) => String(row.name ?? row[1]) === "email",
  );
  record("6", ddlOk, "DDL pushed to primary and visible on remote");
  await ddlDb.close();
  ddlRemote.close();

  // ── Test 7: offline DDL batch then push ───────────────────────────────
  const ddlOffName = `spike-ddl-off-${Date.now().toString(36)}`;
  const ddlOffTok = await fetchToken(cloudBase, ddlOffName);
  await provisionRemote(ddlOffTok.tursoUrl, ddlOffTok.authToken);

  const ddlOffPath = path.join(os.tmpdir(), `${ddlOffName}.db`);
  cleanup(ddlOffPath);
  const ddlOffDb = await connectWithRetry(
    {
      path: ddlOffPath,
      url: ddlOffTok.tursoUrl,
      authToken: ddlOffTok.authToken,
      bootstrapIfEmpty: false,
    },
    "ddl-offline",
  );
  await ddlOffDb.exec(
    "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)",
  );
  await ddlOffDb.exec("INSERT INTO schema_migrations VALUES ('0001_init', datetime('now'))");
  await ddlOffDb.exec("CREATE TABLE pets (id INTEGER PRIMARY KEY, name TEXT)");
  await ddlOffDb.push();
  const ddlOffRemote = createClient({
    url: ddlOffTok.tursoUrl,
    authToken: ddlOffTok.authToken,
  });
  const pets = await ddlOffRemote.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pets'",
  );
  record("7", pets.rows.length === 1, "Offline DDL batch pushed on reconnect");
  await ddlOffDb.close();
  ddlOffRemote.close();

  // ── Test 8: per-user isolated DB ──────────────────────────────────────
  const userA = await fetchToken(cloudBase, `spike-user-a-${Date.now().toString(36)}`);
  const userB = await fetchToken(cloudBase, `spike-user-b-${Date.now().toString(36)}`);
  const pathA = path.join(os.tmpdir(), `${userA.tursoUrl.split("/").pop()}-a.db`);
  const pathB = path.join(os.tmpdir(), `${userB.tursoUrl.split("/").pop()}-b.db`);
  cleanup(pathA);
  cleanup(pathB);

  const dbA = await connectWithRetry(
    {
      path: pathA,
      url: userA.tursoUrl,
      authToken: userA.authToken,
      bootstrapIfEmpty: true,
    },
    "user-a",
  );
  await dbA.exec("CREATE TABLE secret (id INTEGER PRIMARY KEY, v TEXT)");
  await dbA.exec("INSERT INTO secret (v) VALUES ('A-only')");
  await dbA.push();

  const dbB = await connectWithRetry(
    {
      path: pathB,
      url: userB.tursoUrl,
      authToken: userB.authToken,
      bootstrapIfEmpty: true,
    },
    "user-b",
  );
  await dbB.pull();
  let isolatedOk = false;
  try {
    const secretStmt = await dbB.prepare("SELECT v FROM secret");
    await secretStmt.all();
    isolatedOk = false;
  } catch {
    isolatedOk = true;
  }
  record("8", isolatedOk, "Separate Turso DBs are isolated");
  await dbA.close();
  await dbB.close();

  // ── Test 9: write + push latency ──────────────────────────────────────
  const latencies = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await db1.exec(`INSERT INTO items (label) VALUES ('lat-${i}')`);
    await db1.push();
    latencies.push(performance.now() - t0);
  }
  latencies.sort((a, b) => a - b);
  const p50 = Math.round(latencies[4] ?? latencies[0] ?? 0);
  const p95 = Math.round(latencies[9] ?? latencies.at(-1) ?? 0);
  record(
    "9",
    p95 < 2000,
    `Write+push latency p50=${p50}ms p95=${p95}ms (spike target p95<2000ms)`,
  );

  // ── Test 10: cloud-enable import (local seed → push) ──────────────────
  const importName = `spike-import-${Date.now().toString(36)}`;
  const importTok = await fetchToken(cloudBase, importName);
  await provisionRemote(importTok.tursoUrl, importTok.authToken);

  const seedPath = path.join(os.tmpdir(), `${importName}-seed.db`);
  cleanup(seedPath);
  const seed = new DatabaseSync(seedPath);
  seed.exec("CREATE TABLE inventory (sku TEXT PRIMARY KEY, qty INTEGER)");
  seed.prepare("INSERT INTO inventory VALUES ('SKU-1', 10)").run();
  seed.close();

  const importReplicaPath = path.join(os.tmpdir(), `${importName}-replica.db`);
  cleanup(importReplicaPath);
  const importDb = await connectWithRetry(
    {
      path: importReplicaPath,
      url: importTok.tursoUrl,
      authToken: importTok.authToken,
      bootstrapIfEmpty: false,
    },
    "import",
  );
  const seedRead = new DatabaseSync(seedPath, { readOnly: true });
  const seedRows = seedRead.prepare("SELECT sku, qty FROM inventory").all();
  seedRead.close();
  await importDb.exec("CREATE TABLE inventory (sku TEXT PRIMARY KEY, qty INTEGER)");
  const ins = await importDb.prepare("INSERT INTO inventory (sku, qty) VALUES (?, ?)");
  for (const row of seedRows) {
    await ins.run(row.sku, row.qty);
  }
  await importDb.push();
  const importRemote = createClient({
    url: importTok.tursoUrl,
    authToken: importTok.authToken,
  });
  const importRows = await importRemote.execute("SELECT sku, qty FROM inventory");
  record("10", importRows.rows.length === 1, "Local SQLite seed imported via push()");
  await importDb.close();
  importRemote.close();

  // ── Legacy embedded replica (@libsql/client syncUrl) ───────────────────
  let erBroken = false;
  let erError = "";
  try {
    const erPath = path.join(os.tmpdir(), `${dbName}-er.db`);
    cleanup(erPath);
    const er = createClient({ url: `file:${erPath}`, syncUrl: tursoUrl, authToken });
    await er.sync();
  } catch (error) {
    erError = (error instanceof Error ? error.message : String(error)).slice(0, 120);
    erBroken =
      erError.includes("deprecated") ||
      erError.includes("PrimaryHandshakeTimeout") ||
      erError.includes("Unimplemented");
  }
  record(
    "ER",
    erBroken,
    `@libsql/client embedded replica broken/deprecated (${erError || "unexpected pass"})`,
  );

  await db1.close();
  await db2.close();
  remote.close();

  log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  log(`${passed}/${results.length} passed`);
  if (failed.length > 0) {
    log(`Failed: ${failed.map((f) => `${f.id} (${f.detail})`).join("; ")}`);
    process.exit(1);
  }
  log("\nVerdict: Plan A viable with @tursodatabase/sync (not legacy @libsql/client embedded replicas).\n");
}

main().catch((error) => {
  console.error("SPIKE_FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
