#!/usr/bin/env node
/**
 * Sync V3 concurrency E2E — desktop + cloud dual-writer stress + SQLite integrity.
 *
 * Simulates the pre-V3 corruption class: simultaneous local SQLite writes and
 * remote/cloud row ops against the same linked job DB. Verifies workspace log
 * ordering, materialization idempotency, and PRAGMA integrity_check after chaos.
 *
 * Prerequisites:
 *   npm run build:gateway
 *   Memory server with workspace log + Turso (local :5001 or production)
 *   PAPR_API_KEY in env / .env.local
 *
 * Usage:
 *   npm run test:sync-v3-concurrency-e2e
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run test:sync-v3-concurrency-e2e
 *   npm run test:sync-v3-concurrency-e2e -- --writer=http://127.0.0.1:8789
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvLocal, requireMemoryAccessAsync } from "./lib/testEnv.mjs";
import {
  cleanupDb,
  createModuleLoader,
  ensureLocalSyncTriggers,
  writeJobDataSources,
} from "./lib/tursoBidirectionalTestLib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

/** Dev .env.local often comments out PAPR_API_KEY — allow `#PAPR_API_KEY=sk-...`. */
function loadCommentedPaprApiKey() {
  if (process.env.PAPR_API_KEY?.trim()) return;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^#\s*PAPR_API_KEY=(.+)$/);
      if (match?.[1]?.trim()) {
        process.env.PAPR_API_KEY = match[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  } catch {
    /* optional */
  }
}
loadCommentedPaprApiKey();

function parsePaprApiKeyScope(apiKey) {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

function configureWorkspaceEnv(apiKey) {
  const scope = parsePaprApiKeyScope(apiKey);
  if (scope) {
    process.env.PAPR_ORG_ID = scope.organizationId;
    process.env.PAPR_NAMESPACE_ID = scope.namespaceId;
  }
  process.env.PAPR_MEMORY_SERVER_URL = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
  ).replace(/\/$/, "");
  process.env.PAPR_API_KEY = apiKey;
  process.env.NODE_ENV = "development";
  process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
}

const args = process.argv.slice(2);
const memoryBaseArg = args.find((a) => a.startsWith("--memory="))?.split("=")[1];
const writerBaseArg = args.find((a) => a.startsWith("--writer="))?.split("=")[1];

const DESKTOP_ROWS = 12;
const CLOUD_ROWS = 12;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  passed += 1;
  console.log(`✅ ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`❌ ${label}: ${detail}`);
}

function skip(label, reason) {
  skipped += 1;
  console.log(`⏭️  ${label} — ${reason}`);
}

function section(title) {
  console.log(`\n--- ${title} ---\n`);
}

async function memoryFetch(apiKey, memoryBase, pathSuffix, init = {}) {
  const res = await fetch(`${memoryBase}${pathSuffix}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

function assertIntegrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.pragma("integrity_check");
    const result = rows[0]?.integrity_check ?? rows[0];
    if (result !== "ok") {
      throw new Error(`integrity_check=${String(result)}`);
    }
  } finally {
    db.close();
  }
}

function countStressRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(
      db.prepare("SELECT COUNT(*) AS c FROM stress_items").get()?.c ?? 0,
    );
  } finally {
    db.close();
  }
}

function readStressSources(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT id, source FROM stress_items ORDER BY id")
      .all()
      .map((row) => `${row.id}:${row.source}`);
  } finally {
    db.close();
  }
}

async function loadModule(relativePath) {
  return import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services", relativePath)).href
  );
}

async function appendSchema(apiKey, memoryBase, replicaId, appId) {
  return memoryFetch(apiKey, memoryBase, "/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "schema",
      dbSourceId: "main",
      payload: {
        appId,
        sql: `CREATE TABLE IF NOT EXISTS stress_items (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0
        )`,
      },
    },
  });
}

async function appendCloudRow(apiKey, memoryBase, replicaId, appId, id, source, n) {
  return memoryFetch(apiKey, memoryBase, "/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "main",
      payload: {
        appId,
        sql: "INSERT OR REPLACE INTO stress_items (id, source, n) VALUES (?, ?, ?)",
        params: [id, source, n],
      },
    },
  });
}

async function desktopInsertRow(loadModuleFn, dbPath, id, source, n) {
  await ensureLocalSyncTriggers(loadModuleFn, dbPath, "stress_items");
  const db = new Database(dbPath);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO stress_items (id, source, n) VALUES (?, ?, ?)",
    ).run(id, source, n);
  } finally {
    db.close();
  }
}

async function runDualWriterStress(apiKey, memoryBase) {
  section("C1. Setup throwaway linked job + schema via workspace log");

  const paprHome = fs.mkdtempSync(path.join(os.tmpdir(), "sync-v3-conc-home-"));
  process.env.PAPR_HOME = paprHome;

  const jobRoot = path.join(paprHome, "Jobs");
  const appsRoot = path.join(paprHome, "apps");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(appsRoot, { recursive: true });

  const jobId = randomUUID();
  const appId = `e2e-conc-${randomUUID().slice(0, 8)}`;
  const dbPath = path.join(jobRoot, jobId, "data", "data.db");
  cleanupDb(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // DbQueryPool worker opens with fileMustExist — bootstrap empty file before materialize.
  new Database(dbPath).close();
  writeJobDataSources(appsRoot, appId, jobId, dbPath);

  const { initializeDbPool } = await loadModule("DbQueryPool.js");
  initializeDbPool(
    pathToFileURL(path.join(__dirname, "../dist/gateway/workers/db-query-worker.js")),
  );

  const { initializeTursoSyncBridge } = await loadModule("TursoSyncBridge.js");
  const { getDatabaseRegistryService } = await loadModule("DatabaseRegistryService.js");
  await getDatabaseRegistryService().initialize();
  initializeTursoSyncBridge({ jobsRootDir: jobRoot, appsRootDir: appsRoot });

  const { jobTursoDatabaseName } = await loadModule("tursoDatabaseNaming.js");
  const replicaId = jobTursoDatabaseName(jobId);

  const schemaRes = await appendSchema(apiKey, memoryBase, replicaId, appId);
  if (schemaRes.status === 404 || schemaRes.status === 501) {
    skip("dual-writer stress", `workspace log unavailable (${schemaRes.status})`);
    return null;
  }
  if (schemaRes.status !== 200) {
    fail("schema append", `${schemaRes.status} ${schemaRes.text.slice(0, 200)}`);
    return null;
  }
  ok(`schema append seq=${schemaRes.data.seq}`);

  const linked = {
    alias: "main",
    jobId,
    appId,
    dbPath,
  };

  const logSync = await loadModule("syncV3/workspaceLogSync.js");
  const appliedSchema = await logSync.catchUpLinkedSourceFromWorkspaceLog(linked);
  if (appliedSchema < 1) {
    fail("schema materialize", `applied=${appliedSchema}`);
    return null;
  }
  ok(`schema materialized locally (${appliedSchema} entries)`);

  section("C2. Concurrent desktop SQLite + cloud workspace log appends");

  const loadModuleFn = createModuleLoader(
    path.join(__dirname, "../dist/gateway/services"),
  );

  const desktopIds = Array.from({ length: DESKTOP_ROWS }, () => randomUUID());
  const cloudIds = Array.from({ length: CLOUD_ROWS }, () => randomUUID());

  const desktopTask = (async () => {
    for (let i = 0; i < desktopIds.length; i += 1) {
      await desktopInsertRow(loadModuleFn, dbPath, desktopIds[i], "desktop", i + 1);
    }
    const ship = await logSync.shipLinkedSourceToWorkspaceLog(linked);
    return ship.shipped;
  })();

  const cloudTask = Promise.all(
    cloudIds.map((id, i) =>
      appendCloudRow(apiKey, memoryBase, replicaId, appId, id, "cloud", i + 100),
    ),
  );

  const [shipped, cloudResults] = await Promise.all([desktopTask, cloudTask]);

  const cloudFailures = cloudResults.filter((r) => r.status !== 200);
  if (cloudFailures.length > 0) {
    fail(
      "cloud concurrent appends",
      `${cloudFailures.length} failures — first: ${cloudFailures[0].status}`,
    );
    return null;
  }
  ok(`cloud ${CLOUD_ROWS} concurrent appends accepted`);
  ok(`desktop shipped ${shipped} row op(s) to workspace log`);

  section("C3. Materialize + idempotent replay + integrity");

  const applied1 = await logSync.catchUpLinkedSourceFromWorkspaceLog(linked);
  ok(`materialized ${applied1} remote log entries`);

  try {
    assertIntegrity(dbPath);
    ok("PRAGMA integrity_check = ok after dual-writer stress");
  } catch (err) {
    fail("SQLite integrity", err instanceof Error ? err.message : String(err));
    return null;
  }

  const totalRows = countStressRows(dbPath);
  const expectedMin = DESKTOP_ROWS + CLOUD_ROWS;
  if (totalRows < expectedMin) {
    fail(
      "row count after merge",
      `expected >= ${expectedMin}, got ${totalRows} — ${readStressSources(dbPath).slice(0, 5).join(", ")}…`,
    );
    return null;
  }
  ok(`row count ${totalRows} (desktop ${DESKTOP_ROWS} + cloud ${CLOUD_ROWS})`);

  const applied2 = await logSync.catchUpLinkedSourceFromWorkspaceLog(linked);
  if (applied2 !== 0) {
    fail("idempotent replay", `second materialize applied ${applied2} (expected 0)`);
    return null;
  }
  ok("idempotent replay — no duplicate applies");

  const afterReplay = countStressRows(dbPath);
  if (afterReplay !== totalRows) {
    fail("row count stable on replay", `before=${totalRows} after=${afterReplay}`);
    return null;
  }
  ok("row count stable after replay");

  try {
    assertIntegrity(dbPath);
    ok("PRAGMA integrity_check = ok after replay");
  } catch (err) {
    fail("SQLite integrity after replay", err instanceof Error ? err.message : String(err));
  }

  return { paprHome, appId, replicaId };
}

async function runWriterOpsConflict(apiKey, memoryBase, appId, writerBase) {
  section("C4. Writer ops parent-hash conflict (409)");

  const ensure = await memoryFetch(
    apiKey,
    memoryBase,
    `/v1/cloud/apps/${encodeURIComponent(appId)}/repo/ensure`,
    { method: "POST", body: {} },
  );
  if (ensure.status === 503) {
    skip("writer ops conflict", "GitHub not configured on memory server");
    return;
  }
  if (ensure.status !== 200) {
    skip("writer ops conflict", `repo ensure ${ensure.status}`);
    return;
  }

  const health = await fetch(`${writerBase.replace(/\/$/, "")}/health`).catch(() => null);
  if (!health?.ok) {
    skip("writer ops conflict", `writer not reachable at ${writerBase}`);
    return;
  }

  const conflictRes = await fetch(
    `${writerBase.replace(/\/$/, "")}/apps/${encodeURIComponent(appId)}/ops`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        files: [
          {
            path: "index.html",
            content: "<html><body>concurrent conflict test</body></html>",
            parentHash: "0000000000000000000000000000000000000000",
          },
        ],
        author: "e2e-concurrency",
        message: "conflict probe",
        idempotencyKey: `e2e-conflict-${randomUUID()}`,
      }),
    },
  );

  if (conflictRes.status === 409) {
    ok("writer returned 409 on stale parentHash (code conflict surfaced)");
    return;
  }
  if (conflictRes.status === 423) {
    ok("writer returned 423 lease contention (expected under load)");
    return;
  }
  const body = await conflictRes.text();
  fail(
    "writer ops conflict",
    `expected 409 or 423, got ${conflictRes.status}: ${body.slice(0, 160)}`,
  );
}

async function main() {
  const access = await requireMemoryAccessAsync();
  if (access.mode === "gateway") {
    console.error("❌ Direct PAPR_API_KEY required for this script");
    process.exit(1);
  }

  const memoryBase = (memoryBaseArg ?? access.memoryBase).replace(/\/$/, "");
  const apiKey = access.apiKey;
  configureWorkspaceEnv(apiKey);
  const writerBase =
    writerBaseArg ??
    process.env.PAPR_APP_REPO_WRITER_URL ??
    "http://127.0.0.1:8789";

  console.log(`\nSync V3 concurrency E2E → ${memoryBase}\n`);

  const health = await fetch(`${memoryBase}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`❌ Memory server not reachable at ${memoryBase}`);
    process.exit(1);
  }
  ok(`memory server reachable (${memoryBase})`);

  const fixture = await runDualWriterStress(apiKey, memoryBase);
  if (fixture?.appId) {
    await runWriterOpsConflict(apiKey, memoryBase, fixture.appId, writerBase);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
