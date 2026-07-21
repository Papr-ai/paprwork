#!/usr/bin/env node
/**
 * Verify Turso sync optimizations against real local state + optional live Turso.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-turso-sync-verify.mjs
 *
 * Env:
 *   PAPR_MEMORY_SERVER_URL — default https://memory.papr.ai
 *   PAPR_API_KEY — required for live Turso usage sample only
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAPR_HOME = path.join(os.homedir(), "Papr");
const SYNC_STATE = path.join(PAPR_HOME, "data", ".turso-sync-state.json");

const core = await import(
  pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js")).href
);
const fpMod = await import(
  pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoTableFingerprint.js")).href
);
const stateMod = await import(
  pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncState.js")).href
);

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed += 1;
}

function fail(label, detail) {
  console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section("1. Synthetic fingerprint skip (no network)");
{
  const dbPath = path.join(os.tmpdir(), `turso-verify-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO items (v) VALUES ('a');");
  db.close();

  const fp = fpMod.computeSyncableTableFingerprintsForPath(dbPath);
  const r = await core.pushLocalDbToTurso(
    dbPath,
    { tursoUrl: "libsql://mock.turso.io", authToken: "mock" },
    { jobId: "verify-job", previousFingerprints: fp },
  );
  fs.unlinkSync(dbPath);

  if (r.status === "skipped" && r.reason === "all_tables_unchanged") {
    ok("unchanged tables skip before Turso client");
  } else {
    fail("unchanged tables skip", JSON.stringify(r));
  }
}

section("2. Debounce default in compiled scheduler");
{
  const src = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoPushScheduler.js"),
    "utf8",
  );
  if (src.includes("DEFAULT_DEBOUNCE_MS = 60000")) ok("default debounce is 60s");
  else fail("default debounce", "expected 60000");
}

section("3. Real jobs from ~/.turso-sync-state.json");
if (!fs.existsSync(SYNC_STATE)) {
  fail("sync state file missing", SYNC_STATE);
} else {
  const state = JSON.parse(fs.readFileSync(SYNC_STATE, "utf8"));
  const jobs = Object.entries(state.jobs ?? {});
  ok(`found ${jobs.length} tracked jobs`);

  let skipCount = 0;
  let dirtyCount = 0;
  let missingDb = 0;
  const samples = [];

  for (const [jobId, info] of jobs) {
    const dbPath = info.dbPath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      missingDb += 1;
      continue;
    }
    const dirty = stateMod.isJobDbDirty(jobId, dbPath, state);
    if (dirty) dirtyCount += 1;
    else skipCount += 1;

    if (info.tableFingerprints && samples.length < 5) {
      const fp = fpMod.computeSyncableTableFingerprintsForPath(dbPath);
      const prev = info.tableFingerprints;
      const tableNames = Object.keys(fp);
      let match = 0;
      for (const t of tableNames) {
        if (fp[t] === prev[t]) match += 1;
      }
      samples.push({ jobId: jobId.slice(0, 8), tables: tableNames.length, fpMatch: match, dirty });
    }
  }

  ok(`${skipCount} jobs would skip push (not dirty), ${dirtyCount} dirty, ${missingDb} missing db`);
  for (const s of samples) {
    console.log(
      `     job ${s.jobId}… tables=${s.tables} fingerprint_match=${s.fpMatch}/${s.tables} dirty=${s.dirty}`,
    );
  }

  // f98f409f job from earlier errors
  const problemJob = "f98f409f-5efb-4813-9da5-36d10eadab68";
  const problemDb = path.join(PAPR_HOME, "jobs", problemJob, "data", "data.db");
  if (fs.existsSync(problemDb)) {
    if (state.jobs?.[problemJob]) {
      ok(`problem job ${problemJob.slice(0, 8)} is in sync state`);
    } else {
      console.log(
        `  ⚠️  problem job ${problemJob.slice(0, 8)} has data.db but NO sync state (never pushed or unlinked)`,
      );
    }
  }
}

section("4. Incremental upsert path in compiled core");
{
  const src = fs.readFileSync(
    path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js"),
    "utf8",
  );
  if (src.includes("INSERT OR REPLACE") && src.includes("upsertRemoteTableIncremental")) {
    ok("incremental upsert helper present");
  } else fail("incremental upsert missing");
  if (src.includes("all_tables_unchanged")) ok("fingerprint gate present");
  else fail("fingerprint gate missing");
}

section("5. Live Turso read rate (30s sample)");
{
  const apiKey = process.env.PAPR_API_KEY;
  const base = (process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai").replace(/\/$/, "");
  if (!apiKey) {
    console.log("  ⏭️  skip — set PAPR_API_KEY for live Turso sample");
  } else {
    try {
      const tokenResp = await fetch(`${base}/v1/cloud/databases/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ database: "data" }),
      });
      if (!tokenResp.ok) {
        fail("token fetch", `${tokenResp.status} ${(await tokenResp.text()).slice(0, 80)}`);
      } else {
        ok(`token mint HTTP ${tokenResp.status}`);
        const { tursoUrl, authToken } = await tokenResp.json();
        const { createClient } = await import("@libsql/client");
        const client = createClient({ url: tursoUrl, authToken });

        const tables = await client.execute(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        const prefixed = tables.rows.filter((r) => String(r.name).startsWith("src_"));
        console.log(`     remote tables: ${tables.rows.length} total, ${prefixed.length} job-prefixed`);

        // Simulate push skip: list tables only (cheap)
        const t0 = Date.now();
        await client.execute("SELECT 1");
        const t1 = Date.now();
        ok(`Turso ping ${t1 - t0}ms`);

        client.close();
      }
    } catch (e) {
      fail("live Turso", e.message?.slice(0, 100));
    }
  }
}

section("Summary");
console.log(`Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
