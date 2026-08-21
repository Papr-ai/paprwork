#!/usr/bin/env node
/**
 * Cloud DB perf E2E — Phases 1–4 local stack verification with timing.
 *
 * Prerequisites:
 *   1. Local memory: cd ../memory && poetry run python main.py  (:5001)
 *   2. Local cloud app host: PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run start:cloud-app-host
 *   3. PAPR_API_KEY (env, .env.local, or Papr Work keychain via running gateway)
 *   4. PAPR_CLOUD_APP_HOST_KEY in .env.local (must match memory .env)
 *
 * Usage:
 *   npm run test:cloud-db-perf-e2e
 *   node scripts/test-cloud-db-perf-e2e.mjs --app-id=<uuid>
 *   node scripts/test-cloud-db-perf-e2e.mjs --memory=http://127.0.0.1:5001 --host=http://127.0.0.1:8787
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

const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const paprHomeArg = args.find((a) => a.startsWith("--papr-home="))?.split("=")[1];

let apiKey = process.env.PAPR_API_KEY?.trim() ?? "";
let passed = 0;
let failed = 0;
let skipped = 0;

/** @type {Record<string, number[]>} */
const timingSamples = {};

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

function recordTiming(category, key, value) {
  if (!Number.isFinite(value)) return;
  const bucket = `${category}.${key}`;
  if (!timingSamples[bucket]) timingSamples[bucket] = [];
  timingSamples[bucket].push(value);
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseServerTiming(header) {
  /** @type {Record<string, number | string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const semi = trimmed.indexOf(";");
    const name = (semi >= 0 ? trimmed.slice(0, semi) : trimmed).trim();
    const durMatch = trimmed.match(/dur=([0-9.]+)/);
    if (durMatch) {
      out[name] = Number(durMatch[1]);
      continue;
    }
    const descMatch = trimmed.match(/desc="([^"]*)"/);
    if (descMatch) {
      out[name] = descMatch[1];
    }
  }
  return out;
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
    ` credentials=${credentialsMs}ms ensure=${ensureTablesMs}ms ` +
    `oplog=${oplogPipelineMs}ms materialize=${materializePipelineMs}ms`
  );
}

function resolvePaprHome() {
  if (paprHomeArg) return paprHomeArg;
  try {
    const active = JSON.parse(
      readFileSync(join(homedir(), "Papr", ".active-workspace.json"), "utf8"),
    );
    if (active?.paprHome) return active.paprHome;
  } catch {
    /* fallback */
  }
  return join(homedir(), "Papr");
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

function pickAppId(paprHome) {
  if (appIdArg) return appIdArg;
  try {
    const raw = readFileSync(join(paprHome, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const withSources = list.find((app) => {
      if (!app?.id) return false;
      const dsPath = join(paprHome, "apps", app.id, "data-sources.json");
      if (!existsSync(dsPath)) return false;
      try {
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
  if (res.status === 404) {
    const slug = `e2e-perf-${Date.now().toString(36)}`;
    const publish = await memoryFetch("/v1/cloud/apps/publish", {
      method: "POST",
      body: {
        appId,
        slug,
        visibility: "team",
        linkPermission: "read_write",
      },
    });
    if (publish.status !== 200) {
      throw new Error(`auto-publish failed ${publish.status}: ${publish.text.slice(0, 200)}`);
    }
    ok(`auto-published app for E2E slug=${slug}`);
    return fetchPublishContext(appId);
  }
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
  const linkPermission = cfg.linkPermission ?? cfg.link_permission ?? "read";
  return {
    namespaceId,
    slug,
    visibility: cfg.visibility,
    canWrite: linkPermission !== "read",
  };
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
  const started = performance.now();
  const res = await fetch(`${hostBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const clientMs = performance.now() - started;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  const serverTiming = parseServerTiming(res.headers.get("server-timing"));
  return { status: res.status, data, text, clientMs, serverTiming, headers: res.headers };
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
    fail(
      "memory server reachable",
      `cannot connect to ${memoryBase}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (probe.status === 401) {
    fail("memory server auth", "401 — check PAPR_API_KEY");
    return false;
  }
  ok(`memory server reachable via workspace log (${memoryBase})`);
  return true;
}

async function testHostReachable() {
  try {
    const res = await fetch(`${hostBase}/health`);
    if (!res.ok) {
      skip("cloud app host", `health ${res.status}`);
      return false;
    }
    const json = await res.json();
    if (json.service !== "cloud-app-host") {
      skip("cloud app host", `unexpected service: ${json.service}`);
      return false;
    }
    ok(`cloud app host reachable (${hostBase})`);
    return true;
  } catch (err) {
    skip("cloud app host", `${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Phase 4 — combined oplog+materialize pipeline for row appends. */
async function testPhase4CombinedPipeline(replicaId, tableName) {
  console.log("\n--- Phase 4: combined Turso pipeline (memory) ---");

  const schemaRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "schema",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-perf",
        sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`,
      },
    },
  });
  if (schemaRes.status !== 200) {
    fail("phase4 schema append", `${schemaRes.status} ${schemaRes.text.slice(0, 160)}`);
    return null;
  }

  const rowRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-perf",
        sql: `INSERT INTO ${tableName} (n) VALUES (?)`,
        params: [42],
      },
    },
  });
  if (rowRes.status !== 200) {
    fail("phase4 row append", `${rowRes.status} ${rowRes.text.slice(0, 160)}`);
    return null;
  }

  const timing = rowRes.data.timing ?? {};
  recordTiming("phase4", "oplogPipelineMs", timing.oplogPipelineMs);
  recordTiming("phase4", "materializePipelineMs", timing.materializePipelineMs);
  recordTiming("phase4", "latencyMs", rowRes.data.latencyMs);

  if (timing.materializePipelineMs !== 0) {
    fail(
      "phase4 combined pipeline",
      `expected materializePipelineMs=0, got ${timing.materializePipelineMs}${formatAppendTiming(timing)}`,
    );
  } else {
    ok(
      `phase4 row append combined pipeline: seq=${rowRes.data.seq} latencyMs=${rowRes.data.latencyMs ?? "?"}${formatAppendTiming(timing)}`,
    );
  }

  const warmRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId: "e2e-perf",
        sql: `INSERT INTO ${tableName} (n) VALUES (?)`,
        params: [43],
      },
    },
  });
  if (warmRes.status === 200) {
    const warmTiming = warmRes.data.timing ?? {};
    recordTiming("phase4", "warmOplogMs", warmTiming.oplogPipelineMs);
    ok(
      `phase4 warm row append: seq=${warmRes.data.seq} latencyMs=${warmRes.data.latencyMs ?? "?"}${formatAppendTiming(warmTiming)}`,
    );
  }

  return rowRes.data.seq;
}

/** Phase 3 — dual-write app db config to Mongo + verify GET. */
async function testPhase3AppDbConfig(appId, paprHome) {
  console.log("\n--- Phase 3: Mongo app_db_config dual-write ---");

  const dsPath = join(paprHome, "apps", appId, "data-sources.json");
  const ldPath = join(paprHome, "apps", appId, "linked-databases.json");
  if (!existsSync(dsPath)) {
    skip("phase3 db config upload", "data-sources.json missing locally");
    return;
  }

  const dataSources = readFileSync(dsPath, "utf8");
  const linkedDatabases = existsSync(ldPath)
    ? readFileSync(ldPath, "utf8")
    : `${JSON.stringify({ databases: {} }, null, 2)}\n`;
  const updatedAt = new Date().toISOString();

  const putRes = await memoryFetch(
    `/v1/cloud/metadata/apps/${encodeURIComponent(appId)}/db-config`,
    {
      method: "PUT",
      body: {
        dataSources,
        linkedDatabases,
        updatedAt,
        commitSha: `e2e-${Date.now().toString(36)}`,
      },
    },
  );
  if (putRes.status !== 200) {
    fail("phase3 PUT db-config", `${putRes.status} ${putRes.text.slice(0, 160)}`);
    return;
  }
  if (putRes.data.accepted === false) {
    skip("phase3 PUT db-config", "LWW rejected (older updatedAt)");
  } else {
    ok("phase3 PUT db-config accepted");
  }

  const getRes = await memoryFetch(
    `/v1/cloud/metadata/apps/${encodeURIComponent(appId)}/db-config`,
  );
  if (getRes.status !== 200) {
    fail("phase3 GET db-config", `${getRes.status} ${getRes.text.slice(0, 160)}`);
    return;
  }
  if (getRes.data.source !== "mongo") {
    fail("phase3 GET source", `expected mongo, got ${getRes.data.source}`);
  } else {
    ok(`phase3 GET db-config source=mongo updatedAt=${getRes.data.updatedAt || "(set)"}`);
  }
}

/** Phase 1 — access/config cache: compare Server-Timing on repeated queries. */
async function testPhase1QueryTiming(appId, publishCtx) {
  console.log("\n--- Phase 1: query access/config cache (cloud host) ---");

  const headers = cloudHostHeaders(publishCtx);
  const sql = "SELECT 1 AS ok";

  /** @type {number[]} */
  const configSamples = [];
  /** @type {number[]} */
  const accessSamples = [];

  for (let i = 0; i < 3; i += 1) {
    const res = await hostFetch("/api/db/query", {
      method: "POST",
      headers,
      body: { appId, sql, params: [] },
    });
    if (res.status !== 200) {
      fail("phase1 query", `${res.status} ${res.text.slice(0, 160)}`);
      return;
    }
    if (typeof res.serverTiming.config === "number") {
      configSamples.push(res.serverTiming.config);
      recordTiming("phase1", "configMs", res.serverTiming.config);
    }
    if (typeof res.serverTiming.access === "number") {
      accessSamples.push(res.serverTiming.access);
      recordTiming("phase1", "accessMs", res.serverTiming.access);
    }
    recordTiming("phase1", "clientMs", res.clientMs);
    console.log(
      `   query #${i + 1}: client=${Math.round(res.clientMs)}ms` +
        ` access=${res.serverTiming.access ?? "?"}ms` +
        ` config=${res.serverTiming.config ?? "?"}ms` +
        ` turso=${res.serverTiming.turso ?? "?"}ms` +
        ` accessCache=${res.serverTiming.accessCache ?? "?"}` +
        ` configCache=${res.serverTiming.configCache ?? "?"}`,
    );
  }

  if (configSamples.length >= 2) {
    const first = configSamples[0];
    const last = configSamples[configSamples.length - 1];
    ok(`phase1 configMs: first=${Math.round(first)}ms last=${Math.round(last)}ms`);
    if (last > 50 && configSamples.slice(1).every((ms) => ms > 50)) {
      fail(
        "phase1 config cache",
        `repeat queries still >50ms — expected <10ms when configCache=hit (got ${Math.round(last)}ms)`,
      );
    } else if (last <= 50) {
      ok(`phase1 config cache warm: ${Math.round(first)}ms → ${Math.round(last)}ms`);
    }
  } else {
    ok("phase1 query completed (no Server-Timing config breakdown)");
  }

  if (accessSamples.length >= 2) {
    const warmAccess = accessSamples.slice(1);
    const warmMax = Math.max(...warmAccess);
    if (warmMax <= 50) {
      ok(
        `phase1 access cache warm: ${Math.round(accessSamples[0])}ms → max ${Math.round(warmMax)}ms on repeats`,
      );
    } else if (accessSamples[1] <= accessSamples[0]) {
      ok(`phase1 access improved: ${Math.round(accessSamples[0])}ms → ${Math.round(accessSamples[1])}ms`);
      console.warn(
        `   ⚠️  repeat access still ${Math.round(warmMax)}ms — expected <10ms when accessCache=hit`,
      );
    }
  }
}

/** Phase 2 + write path — cloud host write via memory fast-path. */
async function testPhase2WriteTiming(appId, publishCtx) {
  console.log("\n--- Phase 2: cloud host write (memory fast-path) ---");

  if (!publishCtx.canWrite) {
    skip("phase2 write timing", "publish link is read-only");
    return;
  }

  const headers = cloudHostHeaders(publishCtx);
  const tableName = `e2e_perf_${Date.now().toString(36)}`;

  const execRes = await hostFetch("/api/db/exec", {
    method: "POST",
    headers,
    body: {
      appId,
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`,
    },
  });
  if (execRes.status !== 200) {
    fail("phase2 exec schema", `${execRes.status} ${execRes.text.slice(0, 160)}`);
    return;
  }
  ok("phase2 CREATE TABLE via /api/db/exec");

  for (let i = 0; i < 2; i += 1) {
    const writeRes = await hostFetch("/api/db/write", {
      method: "POST",
      headers,
      body: {
        appId,
        sql: `INSERT INTO ${tableName} (label) VALUES (?)`,
        params: [`row-${i}`],
      },
    });
    if (writeRes.status !== 200) {
      fail(`phase2 write #${i + 1}`, `${writeRes.status} ${writeRes.text.slice(0, 160)}`);
      return;
    }
    recordTiming("phase2", "tursoWriteMs", writeRes.serverTiming.turso);
    recordTiming("phase2", "configMs", writeRes.serverTiming.config);
    recordTiming("phase2", "clientMs", writeRes.clientMs);
    console.log(
      `   write #${i + 1}: client=${Math.round(writeRes.clientMs)}ms` +
        ` access=${writeRes.serverTiming.access ?? "?"}ms` +
        ` config=${writeRes.serverTiming.config ?? "?"}ms` +
        ` turso=${writeRes.serverTiming.turso ?? "?"}ms`,
    );
  }
  ok("phase2 two sequential writes succeeded (check memory logs for [WorkspaceLog] fast-path scope)");
}

async function testWriteBatchAndReadback(appId, publishCtx) {
  console.log("\n--- Phase 5: write-batch + Turso read-back ---");

  if (!publishCtx.canWrite) {
    skip("write-batch", "read-only link");
    return;
  }

  const headers = cloudHostHeaders(publishCtx);
  const tableName = `e2e_wb_${Date.now().toString(36)}`;

  await hostFetch("/api/db/exec", {
    method: "POST",
    headers,
    body: {
      appId,
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`,
    },
  });

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
    skip("write-batch", "route not deployed");
    return;
  }
  if (batchRes.status !== 200) {
    fail("write-batch", `${batchRes.status} ${batchRes.text.slice(0, 160)}`);
    return;
  }
  const results = batchRes.data.results;
  if (!Array.isArray(results) || results.filter((r) => r.ok).length !== labels.length) {
    fail("write-batch results", JSON.stringify(batchRes.data).slice(0, 200));
    return;
  }
  ok(`write-batch ${labels.length}/${labels.length} ok (turso=${batchRes.serverTiming.turso ?? "?"}ms)`);

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
    fail("read-back query", `${queryRes.status}`);
    return;
  }
  const queried = (queryRes.data.rows ?? []).map((r) => String(r.label ?? ""));
  const missing = labels.filter((l) => !queried.includes(l));
  if (missing.length) {
    fail("Turso read-back", `missing ${missing.join(", ")} got ${queried.join(", ")}`);
    return;
  }
  ok(`Turso read-back: ${queried.join(", ")}`);
}

function printTimingSummary() {
  console.log("\n--- Timing summary ---");
  for (const [bucket, values] of Object.entries(timingSamples)) {
    if (!values.length) continue;
    console.log(
      `   ${bucket}: n=${values.length} median=${Math.round(median(values))}ms` +
        ` min=${Math.round(Math.min(...values))} max=${Math.round(Math.max(...values))}`,
    );
  }
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
    console.error("❌ PAPR_API_KEY required (env, .env.local, or Papr Work keychain)");
    process.exit(1);
  }

  const paprHome = resolvePaprHome();
  const appId = pickAppId(paprHome);

  console.log("\nCloud DB Perf E2E (Phases 1–4 + write-batch)");
  console.log(`Memory:    ${memoryBase}`);
  console.log(`Host:      ${hostBase}`);
  console.log(`Papr home: ${paprHome}`);
  console.log(`App:       ${appId ?? "(none)"}`);
  console.log("=".repeat(70));

  const memoryOk = await testMemoryReachable();
  if (!memoryOk) {
    console.log("\nStart memory: cd ../memory && poetry run python main.py");
    process.exit(1);
  }

  const replicaId = `j-e2e${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tableName = `e2e_items_${Date.now().toString(36)}`;
  await testPhase4CombinedPipeline(replicaId, tableName);

  const hostOk = await testHostReachable();
  if (!hostOk) {
    console.log("\nStart host: PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run start:cloud-app-host");
  } else if (!process.env.PAPR_CLOUD_APP_HOST_KEY?.trim()) {
    skip("cloud host perf tests", "PAPR_CLOUD_APP_HOST_KEY missing in .env.local");
  } else if (!appId) {
    skip("cloud host perf tests", "pass --app-id= with Turso-linked app");
  } else {
    try {
      const publishCtx = await fetchPublishContext(appId);
      console.log(`Publish: namespace=${publishCtx.namespaceId} slug=${publishCtx.slug}`);

      await testPhase3AppDbConfig(appId, paprHome);
      await testPhase1QueryTiming(appId, publishCtx);
      await testPhase2WriteTiming(appId, publishCtx);
      await testWriteBatchAndReadback(appId, publishCtx);
    } catch (err) {
      skip("cloud host perf tests", err instanceof Error ? err.message : String(err));
    }
  }

  printTimingSummary();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
  console.log("\nAll runnable tests passed.");
  console.log("Tip: watch memory terminal for [WorkspaceLog] fast-path scope on cloud writes.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
