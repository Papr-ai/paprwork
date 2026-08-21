#!/usr/bin/env node
/**
 * Sync V3 E2E — heartbeat handshake + RepoRegistry + P0 coordination + workspace log.
 *
 * Prerequisites (local):
 *   1. Memory server running with Sync V3 routes deployed
 *      cd ../memory && poetry run python main.py   # default :5001
 *   2. PAPR_API_KEY in env or ~/Papr/data/settings.json (Papr login)
 *   3. For RepoRegistry ensure: GITHUB_APP_* + GITHUB_ORG on memory server
 *
 * Usage:
 *   npm run test:sync-v3-e2e
 *
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 PAPR_API_KEY=sk-... \
 *     node scripts/test-sync-v3-e2e.mjs
 *
 *   node scripts/test-sync-v3-e2e.mjs --writeback     # also run job runtime off-git checks
 *   node scripts/test-sync-v3-e2e.mjs --require-github  # fail if repo ensure unavailable (503)
 *   node scripts/test-sync-v3-e2e.mjs --allow-partial   # skip P0 tests when routes return 404 (legacy)
 *   node scripts/test-sync-v3-e2e.mjs --memory=https://memory.papr.ai
 *
 * By default this script verifies Sync V3 routes exist in OpenAPI before probing endpoints.
 * Missing routes fail immediately (no false-positive 404 on GET /repo).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  assertAppRepoRouteHandlesMissingApp,
  verifySyncV3MemoryRoutes,
} from "./lib/syncV3MemoryContract.mjs";

const args = process.argv.slice(2);

const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

const withWriteback = args.includes("--writeback");
const requireGithub = args.includes("--require-github");
const allowPartial = args.includes("--allow-partial");
const requireP0 = !allowPartial;

const THROWAWAY_APP_ID = `e2e-sync-v3-${randomUUID()}`;

function loadApiKey() {
  if (process.env.PAPR_API_KEY) return process.env.PAPR_API_KEY;
  for (const settingsPath of [
    join(homedir(), "Papr", "data", "settings.json"),
    join(homedir(), ".paprwork-v2", "settings.json"),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const key =
        settings?.customKeys?.PAPR_API_KEY ??
        settings?.paprProfile?.apiKey ??
        null;
      if (key) return key;
    } catch {
      /* try next path */
    }
  }
  return null;
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("❌ PAPR_API_KEY required (env or Papr login in settings)");
  process.exit(1);
}

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
  if (requireP0) {
    fail(label, `required test skipped: ${reason}`);
    return;
  }
  skipped += 1;
  console.log(`⏭️  ${label} — ${reason}`);
}

function routeUnavailable(label, status, detail) {
  const msg = `${label}: route unavailable (${status}) — ${detail}`;
  if (allowPartial) {
    skip(label, msg);
    return true;
  }
  fail(label, msg);
  return true;
}

async function testSyncV3RouteContract() {
  const result = await verifySyncV3MemoryRoutes(memoryBase);
  if (!result.ok) {
    fail("Sync V3 OpenAPI route contract", result.error);
    for (const missing of result.missing) {
      console.error(`   missing: ${missing.label}`);
    }
    console.error(
      `   OpenAPI has ${result.paths.length} path(s) — deploy memory server with Sync V3 routers mounted`,
    );
    return false;
  }
  ok(
    `Sync V3 OpenAPI route contract (${result.paths.length} total paths, ${result.paths.filter((p) => p.includes("/workspace/log") || p.includes("/repo")).length} sync paths)`,
  );
  return true;
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

function assertRepoRecord(data, appId) {
  const required = [
    "appId",
    "namespaceId",
    "githubOrg",
    "repoName",
    "shardId",
    "cloneUrl",
    "repoUrl",
    "createdAt",
  ];
  for (const key of required) {
    if (data[key] == null || data[key] === "") {
      fail(`repo record field ${key}`, "missing or empty");
      return false;
    }
  }
  if (data.appId !== appId) {
    fail("repo record appId", `expected ${appId}, got ${data.appId}`);
    return false;
  }
  if (!String(data.cloneUrl).endsWith(".git")) {
    fail("repo record cloneUrl", `expected .git suffix: ${data.cloneUrl}`);
    return false;
  }
  return true;
}

async function testServerReachable() {
  try {
    const res = await fetch(`${memoryBase}/health`, { method: "GET" });
    if (res.ok) {
      ok(`memory server reachable (${memoryBase})`);
      return;
    }
    // Some deployments omit /health — fall through to authenticated probe
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      fail(
        "memory server reachable",
        `cannot connect to ${memoryBase} — start memory server (cd ../memory && poetry run python main.py)`,
      );
      return;
    }
    /* probe below */
  }

  let probe;
  try {
    probe = await memoryFetch("/v1/cloud/runtime/heartbeat", {
      method: "POST",
      body: { syncProtocol: "v2" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      "memory server reachable",
      `cannot connect to ${memoryBase}: ${msg}`,
    );
    return;
  }
  if (probe.status === 401) {
    fail("memory server auth", "401 — check PAPR_API_KEY");
  } else if (probe.status >= 500) {
    fail("memory server reachable", `${probe.status} ${probe.text.slice(0, 120)}`);
  } else {
    ok(`memory server reachable via heartbeat (${memoryBase})`);
  }
}

async function testHeartbeatV2() {
  const res = await memoryFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body: {},
  });
  if (res.status !== 200) {
    fail("heartbeat v2", `${res.status} ${res.text.slice(0, 200)}`);
    return;
  }
  if (!res.data.recordedAt || typeof res.data.staleAfterSeconds !== "number") {
    fail("heartbeat v2 shape", JSON.stringify(res.data).slice(0, 120));
    return;
  }
  if (!Array.isArray(res.data.pendingCloudRuns)) {
    fail("heartbeat v2 pendingCloudRuns", "missing array");
    return;
  }
  ok(`heartbeat v2 (pendingCloudRuns=${res.data.pendingCloudRuns.length})`);
}

async function testHeartbeatV3Handshake() {
  const body = {
    syncProtocol: "v3",
    appVersion: "2.0.0-e2e",
    namespaceId: "e2e-ns",
    syncV3Capabilities: ["SYNC_V3_PER_APP_REPOS"],
  };
  const res = await memoryFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body,
  });
  if (res.status !== 200) {
    fail("heartbeat v3 handshake", `${res.status} ${res.text.slice(0, 200)}`);
    return;
  }
  if (res.status === 200 && !res.data.recordedAt) {
    fail("heartbeat v3 response", "missing recordedAt");
    return;
  }
  ok("heartbeat v3 handshake (syncProtocol + capabilities accepted)");
}

async function testAppRepoRegistry() {
  const probe = await assertAppRepoRouteHandlesMissingApp(
    async (path, init = {}) => {
      const res = await memoryFetch(path, init);
      return { status: res.status, text: res.text };
    },
    THROWAWAY_APP_ID,
  );
  if (!probe.ok) {
    fail("GET /repo (unknown app)", probe.error);
    return;
  }
  ok(`GET /repo 404 for unknown app (${THROWAWAY_APP_ID.slice(0, 24)}…)`);

  const ensure1 = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(THROWAWAY_APP_ID)}/repo/ensure`,
    { method: "POST", body: {} },
  );
  if (ensure1.status === 503) {
    const detail = ensure1.text.slice(0, 200);
    if (requireGithub) {
      fail("POST /repo/ensure", `503 ${detail}`);
    } else {
      skip("POST /repo/ensure", `GitHub not configured on memory server (${detail})`);
    }
    return;
  }
  if (ensure1.status !== 200) {
    fail("POST /repo/ensure", `${ensure1.status} ${ensure1.text.slice(0, 200)}`);
    return;
  }
  if (!assertRepoRecord(ensure1.data, THROWAWAY_APP_ID)) {
    return;
  }
  ok(`POST /repo/ensure created ${ensure1.data.githubOrg}/${ensure1.data.repoName}`);

  const getAfter = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(THROWAWAY_APP_ID)}/repo`,
  );
  if (getAfter.status !== 200) {
    fail("GET /repo after ensure", `${getAfter.status} ${getAfter.text.slice(0, 160)}`);
    return;
  }
  if (getAfter.data.cloneUrl !== ensure1.data.cloneUrl) {
    fail(
      "GET /repo matches ensure",
      `cloneUrl mismatch: ${getAfter.data.cloneUrl} vs ${ensure1.data.cloneUrl}`,
    );
    return;
  }
  ok("GET /repo returns same record after ensure");

  const ensure2 = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(THROWAWAY_APP_ID)}/repo/ensure`,
    { method: "POST", body: {} },
  );
  if (ensure2.status !== 200) {
    fail("POST /repo/ensure idempotent", `${ensure2.status} ${ensure2.text.slice(0, 160)}`);
    return;
  }
  if (ensure2.data.cloneUrl !== ensure1.data.cloneUrl) {
    fail(
      "POST /repo/ensure idempotent",
      `cloneUrl changed on second ensure`,
    );
    return;
  }
  if (ensure2.data.createdAt !== ensure1.data.createdAt) {
    fail(
      "POST /repo/ensure idempotent",
      `createdAt changed on second ensure`,
    );
    return;
  }
  ok("POST /repo/ensure idempotent (same cloneUrl + createdAt)");
}

async function testSchedulerRunLeaseCrossSide() {
  const jobId = `e2e-lease-${randomUUID().slice(0, 8)}`;
  const dueAt = new Date().toISOString();

  const desktopAcquire = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/acquire",
    {
      method: "POST",
      body: { jobId, dueAt, holder: "desktop" },
    },
  );
  if (desktopAcquire.status === 404 || desktopAcquire.status === 501) {
    routeUnavailable(
      "scheduler run lease",
      desktopAcquire.status,
      "deploy latest memory server",
    );
    return;
  }
  if (desktopAcquire.status !== 200) {
    fail("scheduler lease desktop acquire", `${desktopAcquire.status} ${desktopAcquire.text.slice(0, 160)}`);
    return;
  }
  if (!desktopAcquire.data.acquired || !desktopAcquire.data.runId) {
    fail("scheduler lease desktop acquire", JSON.stringify(desktopAcquire.data).slice(0, 120));
    return;
  }
  const desktopRunId = desktopAcquire.data.runId;
  ok(`scheduler lease desktop acquired runId=${desktopRunId}`);

  const cloudAcquire = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/acquire",
    {
      method: "POST",
      body: { jobId, dueAt, holder: "cloud:e2e-replica" },
    },
  );
  if (cloudAcquire.status !== 200) {
    fail("scheduler lease cloud acquire (contention)", `${cloudAcquire.status}`);
    return;
  }
  if (cloudAcquire.data.acquired) {
    skip(
      "scheduler lease cross-side contention",
      "both holders acquired (Mongo degraded?) — skipping strict contention check",
    );
  } else {
    ok("scheduler lease cloud blocked while desktop holds slot");
  }

  const desktopRelease = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/release",
    {
      method: "POST",
      body: { jobId, dueAt, runId: desktopRunId, holder: "desktop" },
    },
  );
  if (desktopRelease.status !== 200 || !desktopRelease.data.released) {
    fail("scheduler lease desktop release", desktopRelease.text.slice(0, 160));
    return;
  }
  ok("scheduler lease desktop released");

  const cloudAcquire2 = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/acquire",
    {
      method: "POST",
      body: { jobId, dueAt, holder: "cloud:e2e-replica" },
    },
  );
  if (cloudAcquire2.status !== 200 || !cloudAcquire2.data.acquired) {
    fail("scheduler lease cloud acquire after release", cloudAcquire2.text.slice(0, 160));
    return;
  }
  ok(`scheduler lease cloud acquired after release runId=${cloudAcquire2.data.runId}`);

  await memoryFetch("/v1/cloud/runtime/scheduler-run-lease/release", {
    method: "POST",
    body: {
      jobId,
      dueAt,
      runId: cloudAcquire2.data.runId,
      holder: "cloud:e2e-replica",
    },
  });
  ok("scheduler lease cloud released");
}

async function testWriterDistributedLease(appId) {
  const holderA = "writer:e2e-a";
  const holderB = "writer:e2e-b";

  const acquire1 = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/acquire`,
    { method: "POST", body: { holder: holderA } },
  );
  if (acquire1.status === 404 || acquire1.status === 501) {
    routeUnavailable(
      "writer distributed lease",
      acquire1.status,
      "deploy latest memory server",
    );
    return;
  }
  if (acquire1.status === 501 || acquire1.status === 503) {
    routeUnavailable("writer distributed lease", acquire1.status, acquire1.text.slice(0, 120));
    return;
  }
  if (acquire1.status !== 200) {
    fail("writer lease acquire", `${acquire1.status} ${acquire1.text.slice(0, 160)}`);
    return;
  }
  if (!acquire1.data.acquired || !acquire1.data.token) {
    fail("writer lease acquire", JSON.stringify(acquire1.data).slice(0, 120));
    return;
  }
  ok(`writer lease acquired token=${String(acquire1.data.token).slice(0, 8)}…`);

  const acquire2 = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/acquire`,
    { method: "POST", body: { holder: holderB } },
  );
  if (acquire2.status !== 200) {
    fail("writer lease second acquire", `${acquire2.status}`);
    return;
  }
  if (acquire2.data.acquired) {
    skip(
      "writer lease contention",
      "second holder acquired (Mongo degraded?) — skipping strict check",
    );
  } else {
    ok("writer lease second holder blocked (contention)");
  }

  const acquireSame = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/acquire`,
    { method: "POST", body: { holder: holderA } },
  );
  if (acquireSame.status !== 200 || !acquireSame.data.acquired) {
    fail("writer lease idempotent re-acquire", acquireSame.text.slice(0, 160));
    return;
  }
  if (acquireSame.data.token !== acquire1.data.token) {
    fail(
      "writer lease idempotent re-acquire",
      "expected same token for same holder",
    );
    return;
  }
  ok("writer lease idempotent re-acquire (same token)");

  const release = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/release`,
    {
      method: "POST",
      body: { token: acquire1.data.token, holder: holderA },
    },
  );
  if (release.status !== 200 || !release.data.released) {
    fail("writer lease release", release.text.slice(0, 160));
    return;
  }
  ok("writer lease released");

  const acquire3 = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/acquire`,
    { method: "POST", body: { holder: holderB } },
  );
  if (acquire3.status === 200 && acquire3.data.acquired) {
    ok("writer lease re-acquire after release");
    await memoryFetch(
      `/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/release`,
      {
        method: "POST",
        body: { token: acquire3.data.token, holder: holderB },
      },
    );
  } else {
    fail("writer lease re-acquire after release", acquire3.text.slice(0, 120));
  }
}

async function testWorkspaceLogReplaySafety() {
  const replicaId = `j-e2e${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const appId = "e2e-log-app";

  const schemaRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "schema",
      dbSourceId: "primary",
      payload: {
        appId,
        sql: "CREATE TABLE IF NOT EXISTS e2e_items (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
      },
    },
  });
  if (schemaRes.status === 404 || schemaRes.status === 501) {
    routeUnavailable("workspace log replay", schemaRes.status, schemaRes.text.slice(0, 120));
    return;
  }
  if (schemaRes.status === 500) {
    skip(
      "workspace log replay",
      `server error (${schemaRes.text.slice(0, 120)}) — deploy memory + Turso`,
    );
    return;
  }
  if (schemaRes.status !== 200) {
    fail("workspace log schema append", `${schemaRes.status} ${schemaRes.text.slice(0, 200)}`);
    return;
  }
  if (typeof schemaRes.data.seq !== "number" || schemaRes.data.seq < 1) {
    fail("workspace log schema seq", JSON.stringify(schemaRes.data).slice(0, 120));
    return;
  }
  ok(`workspace log schema append seq=${schemaRes.data.seq}`);

  const migrationHash =
    "c4da7464e19b7121fb109862441844e422520672de3e2cdc98b7afc45ee3c992";
  const migrationRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "schema",
      dbSourceId: "primary",
      payload: {
        appId,
        dbSlug: "primary",
        migrationId: "e2e_test_migration",
        contentHash: migrationHash,
        statements: [
          "CREATE TABLE IF NOT EXISTS e2e_migration_probe (id INTEGER PRIMARY KEY)",
        ],
      },
    },
  });
  if (migrationRes.status !== 200) {
    fail(
      "workspace log migration schema append",
      `${migrationRes.status} ${migrationRes.text.slice(0, 200)}`,
    );
    return;
  }
  ok(`workspace log migration schema append seq=${migrationRes.data.seq}`);

  const rowRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId,
        sql: "INSERT OR REPLACE INTO e2e_items (id, n) VALUES (?, ?)",
        params: [1, 42],
      },
    },
  });
  if (rowRes.status !== 200) {
    fail("workspace log row append", `${rowRes.status} ${rowRes.text.slice(0, 200)}`);
    return;
  }
  if (rowRes.data.seq !== schemaRes.data.seq + 2) {
    fail(
      "workspace log monotonic seq",
      `expected ${schemaRes.data.seq + 2}, got ${rowRes.data.seq}`,
    );
    return;
  }
  ok(`workspace log row append seq=${rowRes.data.seq}`);

  const badRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: {
        appId,
        sql: "UPDATE e2e_items SET n = n + 1 WHERE id = ?",
        params: [1],
      },
    },
  });
  if (badRes.status >= 200 && badRes.status < 300) {
    fail("workspace log rejects non-idempotent UPDATE", `unexpected ${badRes.status} success`);
    return;
  }
  ok(`workspace log rejects increment UPDATE (${badRes.status})`);

  const since = await memoryFetch(
    `/v1/cloud/workspace/log/since?replicaId=${encodeURIComponent(replicaId)}&cursor=0&limit=50`,
  );
  if (since.status !== 200) {
    fail("workspace log since", `${since.status} ${since.text.slice(0, 160)}`);
    return;
  }
  const entries = since.data.entries ?? [];
  if (entries.length < 3) {
    fail("workspace log since entries", `expected ≥3, got ${entries.length}`);
    return;
  }
  ok(`workspace log since returned ${entries.length} entries (cursor replay source)`);
}

async function testJobRuntimeUpsertRoundTrip() {
  const jobId = `e2e-sync-v3-runtime-${randomUUID().slice(0, 8)}`;
  const recordedAt = new Date().toISOString();
  const marker = `SYNC_V3_E2E_${Date.now()}`;

  const upsert = await memoryFetch("/v1/cloud/runtime/job-runtime/upsert", {
    method: "POST",
    body: {
      jobId,
      status: "completed",
      recordedAt,
      lastRunAt: recordedAt,
      lastOutput: marker,
      source: "sync_v3_e2e",
    },
  });
  if (upsert.status !== 200) {
    fail("job-runtime upsert", `${upsert.status} ${upsert.text.slice(0, 200)}`);
    return;
  }
  if (!upsert.data.accepted) {
    fail("job-runtime upsert accepted", JSON.stringify(upsert.data).slice(0, 120));
    return;
  }
  ok(`job-runtime upsert accepted (${jobId})`);

  const list = await memoryFetch("/v1/cloud/runtime/job-runtime");
  if (list.status !== 200) {
    fail("job-runtime list", `${list.status} ${list.text.slice(0, 160)}`);
    return;
  }
  const patches = list.data.patches ?? [];
  const found = patches.find((p) => p?.jobId === jobId);
  if (!found) {
    fail("job-runtime list contains patch", `jobId ${jobId} not in ${patches.length} patch(es)`);
    return;
  }
  if (!String(found?.lastOutput ?? "").includes(marker)) {
    fail("job-runtime patch lastOutput", `expected marker ${marker}`);
    return;
  }
  ok("job-runtime list round-trip (Mongo authoritative, no git)");

  const hb = await memoryFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body: { syncProtocol: "v3" },
  });
  if (hb.status !== 200) {
    fail("heartbeat after upsert", `${hb.status}`);
    return;
  }
  const pending = hb.data.pendingCloudRuns ?? [];
  const pendingPatch = pending.find((p) => p?.jobId === jobId);
  if (pendingPatch) {
    ok(`heartbeat pendingCloudRuns includes ${jobId}`);
  } else {
    ok("heartbeat pendingCloudRuns (patch may have drained on prior ping)");
  }
}

function runWritebackSuite() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/test-cloud-job-writeback-e2e.mjs", `--memory=${memoryBase}`],
      {
        stdio: "inherit",
        env: { ...process.env, PAPR_API_KEY: apiKey, PAPR_MEMORY_SERVER_URL: memoryBase },
      },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

console.log(`\nSync V3 E2E → ${memoryBase}`);
console.log(`Throwaway appId: ${THROWAWAY_APP_ID}`);
if (allowPartial) {
  console.log("Mode: --allow-partial (missing routes may skip instead of fail)\n");
} else {
  console.log("Mode: strict (OpenAPI route contract + all P0 tests required)\n");
}

await testServerReachable();
if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(1);
}
const contractOk = await testSyncV3RouteContract();
if (!contractOk) {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(1);
}
await testHeartbeatV2();
await testHeartbeatV3Handshake();
await testAppRepoRegistry();
await testSchedulerRunLeaseCrossSide();
await testWriterDistributedLease(THROWAWAY_APP_ID);
await testWorkspaceLogReplaySafety();
await testJobRuntimeUpsertRoundTrip();

if (withWriteback) {
  console.log("\n--- Chaining job runtime writeback E2E ---\n");
  const writebackCode = await runWritebackSuite();
  if (writebackCode !== 0) {
    failed += 1;
    console.error("❌ cloud job writeback suite failed");
  } else {
    passed += 1;
    ok("cloud job writeback suite");
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
