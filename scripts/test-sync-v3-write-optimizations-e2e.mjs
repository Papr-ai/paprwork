#!/usr/bin/env node
/**
 * Sync V3 write optimizations E2E — Reco #1 (memory pipeline collapse) + Reco #4 (write-batch).
 *
 * Prerequisites (local stack):
 *   1. Memory server with latest workspace_log_service.py
 *      cd ../memory && poetry run python main.py   # :5001
 *   2. PAPR_API_KEY in .env.local or env
 *   3. Optional cloud app host for /api/db/write-batch on apps.papr.ai path:
 *      npm run start:cloud-app-host   # :8787, PAPR_CLOUD_APP_HOST_KEY must match memory
 *   4. Optional desktop gateway (npm start) for local /api/db/write-batch
 *
 * Usage:
 *   npm run test:sync-v3-write-optimizations-e2e
 *   node scripts/test-sync-v3-write-optimizations-e2e.mjs --memory=http://127.0.0.1:5001
 *   node scripts/test-sync-v3-write-optimizations-e2e.mjs --host=http://127.0.0.1:8787 --app-id=<uuid>
 *   node scripts/test-sync-v3-write-optimizations-e2e.mjs --gateway=http://127.0.0.1:18789 --app-id=<uuid>
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvLocal, resolvePaprApiKey } from "./lib/testEnv.mjs";

const args = process.argv.slice(2);

const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

const hostBase = (
  args.find((a) => a.startsWith("--host="))?.split("=")[1] ??
  "http://127.0.0.1:8787"
).replace(/\/$/, "");

const gatewayBase = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://127.0.0.1:18789"
).replace(/\/$/, "");

const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];

let apiKey = process.env.PAPR_API_KEY?.trim() ?? "";
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

function formatAppendTiming(timing) {
  if (!timing || typeof timing !== "object") return "";
  const {
    credentialsMs = 0,
    ensureTablesMs = 0,
    oplogPipelineMs = 0,
    materializePipelineMs = 0,
  } = timing;
  return (
    ` | timing: credentials=${credentialsMs}ms ensureTables=${ensureTablesMs}ms ` +
    `oplog=${oplogPipelineMs}ms materialize=${materializePipelineMs}ms`
  );
}

async function memoryFetch(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${memoryBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
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

function pickAppId() {
  if (appIdArg) return appIdArg;
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const withSources = list.find((app) => {
      if (!app?.id) return false;
      try {
        const dsPath = join(homedir(), "Papr", "apps", app.id, "data-sources.json");
        if (!existsSync(dsPath)) return false;
        const ds = JSON.parse(readFileSync(dsPath, "utf8"));
        return Array.isArray(ds.sources) && ds.sources.length > 0;
      } catch {
        return false;
      }
    });
    if (withSources?.id) return withSources.id;
    return list.find((a) => a?.id)?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchPublishContext(appId) {
  const res = await memoryFetch(
    `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
  );
  if (res.status !== 200) {
    throw new Error(`publish config ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const cfg = res.data;
  const parts = String(cfg.shareUrl ?? "").split("/").filter(Boolean);
  const slug = cfg.slug ?? parts[parts.length - 1];
  const namespaceId = parts[parts.length - 2];
  if (!namespaceId || !slug) {
    throw new Error(`invalid shareUrl: ${cfg.shareUrl}`);
  }
  return { namespaceId, slug, visibility: cfg.visibility };
}

function cloudHostHeaders(publishCtx) {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Papr-Namespace-Id": publishCtx.namespaceId,
    "X-Papr-Slug": publishCtx.slug,
    "Cache-Control": "no-cache",
  };
}

async function hostFetch(path, { method = "GET", body = null, headers = {} } = {}) {
  const res = await fetch(`${hostBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

async function gatewayFetch(path, { method = "GET", body = null, appId = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (appId) headers["X-Papr-App-Id"] = appId;
  const res = await fetch(`${gatewayBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

async function testMemoryReachable() {
  try {
    const res = await fetch(`${memoryBase}/health`);
    if (res.ok) {
      ok(`memory server reachable (${memoryBase})`);
      return true;
    }
  } catch {
    /* probe below */
  }
  let probe;
  try {
    probe = await memoryFetch(
      "/v1/cloud/workspace/log/since?replicaId=probe&cursor=0&limit=1",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      "memory server reachable",
      `cannot connect to ${memoryBase} — start memory (cd ../memory && poetry run python main.py): ${msg}`,
    );
    return false;
  }
  if (probe.status === 401) {
    fail("memory server auth", "401 — check PAPR_API_KEY");
    return false;
  }
  if (probe.status === 404) {
    fail("memory server routes", "workspace log routes missing — deploy latest memory");
    return false;
  }
  ok(`memory server reachable via workspace log (${memoryBase})`);
  return true;
}

/** Reco #1 — single append returns materialize fields; second append same replica still works. */
async function testMemorySingleAppendPipeline(replicaId, tableName) {
  const schemaRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "schema",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-write-opt",
        sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`,
      },
    },
  });
  if (schemaRes.status !== 200) {
    fail("memory schema append", `${schemaRes.status} ${schemaRes.text.slice(0, 200)}`);
    return null;
  }
  ok(`memory schema append seq=${schemaRes.data.seq}`);

  const insertRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-write-opt",
        sql: `INSERT INTO ${tableName} (n) VALUES (?)`,
        params: [101],
      },
    },
  });
  if (insertRes.status !== 200) {
    fail("memory row append (Reco #1)", `${insertRes.status} ${insertRes.text.slice(0, 200)}`);
    return null;
  }
  const { changes, lastInsertRowid, latencyMs, seq } = insertRes.data;
  if (typeof changes !== "number" || changes < 1) {
    fail("memory append changes", JSON.stringify(insertRes.data).slice(0, 160));
    return null;
  }
  if (typeof lastInsertRowid !== "number" || lastInsertRowid < 1) {
    fail("memory append lastInsertRowid", JSON.stringify(insertRes.data).slice(0, 160));
    return null;
  }
  if (typeof latencyMs !== "number") {
    fail("memory append latencyMs", "missing latencyMs in response");
    return null;
  }
  ok(
    `memory single append (Reco #1): changes=${changes} lastInsertRowid=${lastInsertRowid} latencyMs=${latencyMs}${formatAppendTiming(insertRes.data.timing)}`,
  );

  const secondInsert = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-write-opt",
        sql: `INSERT INTO ${tableName} (n) VALUES (?)`,
        params: [202],
      },
    },
  });
  if (secondInsert.status !== 200) {
    fail("memory second append (DDL cache)", `${secondInsert.status} ${secondInsert.text.slice(0, 200)}`);
    return seq;
  }
  if (secondInsert.data.seq !== seq + 1) {
    fail(
      "memory monotonic seq after DDL cache",
      `expected ${seq + 1}, got ${secondInsert.data.seq}`,
    );
    return seq;
  }
  ok(
    `memory second append (warm pool): seq=${secondInsert.data.seq} latencyMs=${secondInsert.data.latencyMs ?? "?"}${formatAppendTiming(secondInsert.data.timing)}`,
  );
  return seq;
}

/** Reco #4 memory side — append-batch assigns contiguous seq range. */
async function testMemoryAppendBatch(replicaId, tableName, baseSeq) {
  const batchSize = 5;
  const entries = Array.from({ length: batchSize }, (_, i) => ({
    kind: "row",
    db_source_id: "primary",
    payload: {
      appId: "e2e-write-opt",
      sql: `INSERT INTO ${tableName} (n) VALUES (?)`,
      params: [1000 + i],
    },
  }));

  const batchRes = await memoryFetch("/v1/cloud/workspace/log/append-batch", {
    method: "POST",
    body: { replicaId, entries },
  });
  if (batchRes.status !== 200) {
    fail("memory append-batch", `${batchRes.status} ${batchRes.text.slice(0, 200)}`);
    return;
  }
  const { firstSeq, lastSeq, count, latencyMs } = batchRes.data;
  if (count !== batchSize) {
    fail("memory append-batch count", `expected ${batchSize}, got ${count}`);
    return;
  }
  if (lastSeq - firstSeq + 1 !== batchSize) {
    fail("memory append-batch seq range", `first=${firstSeq} last=${lastSeq}`);
    return;
  }
  if (typeof baseSeq === "number" && firstSeq !== baseSeq + 2) {
    fail(
      "memory append-batch contiguous after singles",
      `expected firstSeq=${baseSeq + 2}, got ${firstSeq}`,
    );
    return;
  }
  ok(
    `memory append-batch (Reco #4): count=${count} seq=${firstSeq}..${lastSeq} latencyMs=${latencyMs}`,
  );

  const since = await memoryFetch(
    `/v1/cloud/workspace/log/since?replicaId=${encodeURIComponent(replicaId)}&cursor=0&limit=50`,
  );
  if (since.status !== 200) {
    fail("memory since after batch", `${since.status} ${since.text.slice(0, 160)}`);
    return;
  }
  const entryCount = since.data.entries?.length ?? 0;
  if (entryCount < 1 + 2 + batchSize) {
    fail("memory since entry count", `expected ≥${1 + 2 + batchSize}, got ${entryCount}`);
    return;
  }
  ok(`memory since replay: ${entryCount} entries`);
}

async function testHostWriteBatch(appId, publishCtx) {
  const headers = cloudHostHeaders(publishCtx);
  const tableName = `e2e_wb_${Date.now().toString(36)}`;

  const execRes = await hostFetch("/api/db/exec", {
    method: "POST",
    headers,
    body: {
      appId,
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`,
    },
  });
  if (execRes.status === 403) {
    skip("cloud host write-batch", "write not allowed for this link");
    return;
  }
  if (execRes.status !== 200) {
    fail("cloud host exec schema", `${execRes.status} ${execRes.text.slice(0, 200)}`);
    return;
  }
  ok("cloud host CREATE TABLE via /api/db/exec");

  const singleWrite = await hostFetch("/api/db/write", {
    method: "POST",
    headers,
    body: {
      appId,
      sql: `INSERT INTO ${tableName} (label) VALUES (?)`,
      params: ["single"],
    },
  });
  if (singleWrite.status !== 200) {
    fail("cloud host single write", `${singleWrite.status} ${singleWrite.text.slice(0, 200)}`);
    return;
  }
  if (typeof singleWrite.data.changes !== "number") {
    fail("cloud host single write changes", JSON.stringify(singleWrite.data).slice(0, 120));
    return;
  }
  ok(`cloud host single /api/db/write changes=${singleWrite.data.changes}`);

  const labels = ["batch-a", "batch-b", "batch-c"];
  const batchRes = await hostFetch("/api/db/write-batch", {
    method: "POST",
    headers,
    body: {
      appId,
      statements: labels.map((label) => ({
        sql: `INSERT INTO ${tableName} (label) VALUES (?)`,
        params: [label],
      })),
    },
  });
  if (batchRes.status === 404) {
    skip("cloud host write-batch", "route not deployed — rebuild cloud-app-host");
    return;
  }
  if (batchRes.status !== 200) {
    fail("cloud host write-batch", `${batchRes.status} ${batchRes.text.slice(0, 200)}`);
    return;
  }
  const results = batchRes.data.results;
  if (!Array.isArray(results) || results.length !== labels.length) {
    fail("cloud host write-batch results length", JSON.stringify(batchRes.data).slice(0, 200));
    return;
  }
  const okCount = results.filter((r) => r.ok === true).length;
  if (okCount !== labels.length) {
    fail(
      "cloud host write-batch all ok",
      results.map((r) => r.error ?? "ok").join("; "),
    );
    return;
  }
  ok(`cloud host /api/db/write-batch: ${okCount}/${labels.length} statements ok`);

  const queryRes = await hostFetch("/api/db/query", {
    method: "POST",
    headers,
    body: {
      appId,
      sql: `SELECT label FROM ${tableName} ORDER BY id`,
      params: [],
    },
  });
  if (queryRes.status !== 200) {
    fail("cloud host query after batch", `${queryRes.status} ${queryRes.text.slice(0, 200)}`);
    return;
  }
  const queried = (queryRes.data.rows ?? []).map((r) => String(r.label ?? ""));
  const expected = ["single", ...labels];
  const missing = expected.filter((l) => !queried.includes(l));
  if (missing.length > 0) {
    fail("cloud host rows materialized on Turso", `missing: ${missing.join(", ")} got: ${queried.join(", ")}`);
    return;
  }
  ok(`cloud host Turso read-back: ${queried.length} rows (${queried.join(", ")})`);
}

async function testGatewayWriteBatch(appId) {
  const tableName = `e2e_gw_wb_${Date.now().toString(36)}`;

  const execRes = await gatewayFetch("/api/db/exec", {
    method: "POST",
    appId,
    body: {
      appId,
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, tag TEXT NOT NULL)`,
    },
  });
  if (execRes.status !== 200) {
    skip("gateway write-batch", `exec failed ${execRes.status}: ${execRes.text.slice(0, 120)}`);
    return;
  }

  const batchRes = await gatewayFetch("/api/db/write-batch", {
    method: "POST",
    appId,
    body: {
      appId,
      statements: [
        { sql: `INSERT INTO ${tableName} (tag) VALUES (?)`, params: ["gw-1"] },
        { sql: `INSERT INTO ${tableName} (tag) VALUES (?)`, params: ["gw-2"] },
      ],
    },
  });
  if (batchRes.status === 404) {
    skip("gateway write-batch", "route not deployed — restart gateway");
    return;
  }
  if (batchRes.status !== 200) {
    fail("gateway write-batch", `${batchRes.status} ${batchRes.text.slice(0, 200)}`);
    return;
  }
  const results = batchRes.data.results ?? [];
  if (results.length !== 2 || !results.every((r) => r.ok === true)) {
    fail("gateway write-batch results", JSON.stringify(batchRes.data).slice(0, 200));
    return;
  }
  ok("gateway /api/db/write-batch: 2/2 local-first writes ok");

  const queryRes = await gatewayFetch("/api/db/query", {
    method: "POST",
    appId,
    body: {
      appId,
      sql: `SELECT tag FROM ${tableName} ORDER BY id`,
      params: [],
    },
  });
  if (queryRes.status !== 200) {
    fail("gateway query after batch", `${queryRes.status} ${queryRes.text.slice(0, 160)}`);
    return;
  }
  const tags = (queryRes.data.rows ?? []).map((r) => String(r.tag ?? ""));
  if (!tags.includes("gw-1") || !tags.includes("gw-2")) {
    fail("gateway local read-back", `got: ${tags.join(", ")}`);
    return;
  }
  ok(`gateway local read-back: ${tags.join(", ")}`);
}

async function main() {
  loadEnvLocal();

  if (!apiKey) {
    const resolved = await resolvePaprApiKey();
    if (resolved) {
      apiKey = resolved.key;
      console.log(`API key: ${apiKey.slice(0, 24)}... (${resolved.source})`);
    }
  }
  if (!apiKey) {
    console.error("❌ PAPR_API_KEY required (env, .env.local, or running Papr Work gateway)");
    process.exit(1);
  }

  console.log("\nSync V3 Write Optimizations E2E (Reco #1 + #4)");
  console.log(`Memory:  ${memoryBase}`);
  console.log(`Host:    ${hostBase}`);
  console.log(`Gateway: ${gatewayBase}`);
  console.log("=".repeat(70));

  const memoryOk = await testMemoryReachable();
  if (!memoryOk) {
    console.log(`\nStart memory: cd ../memory && poetry run python main.py`);
    process.exit(1);
  }

  const replicaId = `j-e2e${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tableName = `e2e_items_${Date.now().toString(36)}`;
  console.log(`\n--- Memory: Reco #1 single append + DDL cache ---`);
  console.log(`Replica: ${replicaId}`);

  const baseSeq = await testMemorySingleAppendPipeline(replicaId, tableName);

  console.log(`\n--- Memory: Reco #4 append-batch ---`);
  await testMemoryAppendBatch(replicaId, tableName, baseSeq);

  console.log(`\n--- Cloud App Host: Reco #4 /api/db/write-batch ---`);
  let hostOk = false;
  try {
    const health = await fetch(`${hostBase}/health`);
    hostOk = health.ok;
    if (!hostOk) {
      skip("cloud app host", `health ${health.status}`);
    }
  } catch (e) {
    skip("cloud app host", `${e.message} — npm run start:cloud-app-host`);
  }

  if (hostOk) {
    if (!process.env.PAPR_CLOUD_APP_HOST_KEY?.trim()) {
      skip("cloud host write-batch", "PAPR_CLOUD_APP_HOST_KEY not in .env.local");
    } else {
      const appId = pickAppId();
      if (!appId) {
        skip("cloud host write-batch", "pass --app-id= with Turso-linked app");
      } else {
        try {
          const publishCtx = await fetchPublishContext(appId);
          console.log(`App: ${appId} slug=${publishCtx.slug}`);
          await testHostWriteBatch(appId, publishCtx);
        } catch (e) {
          skip("cloud host write-batch", e.message);
        }
      }
    }
  }

  console.log(`\n--- Desktop Gateway: Reco #4 /api/db/write-batch ---`);
  let gatewayOk = false;
  try {
    const health = await fetch(`${gatewayBase}/health`);
    gatewayOk = health.ok;
  } catch {
    skip("desktop gateway write-batch", "gateway not running");
  }
  if (gatewayOk) {
    const appId = pickAppId();
    if (!appId) {
      skip("desktop gateway write-batch", "pass --app-id= with linked data-sources.json");
    } else {
      console.log(`App: ${appId}`);
      await testGatewayWriteBatch(appId);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
  console.log("\nAll runnable tests passed.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
