#!/usr/bin/env node
/**
 * E2E — Cloud App Host Phases 2–4 (local or staging).
 *
 * Phase 2: Turso db-token cache (memory + host), backend action cache
 * Phase 3: /internal/app-revision-updated → deploy snapshot warm (needs GCS bucket)
 * Phase 4: CDN-Cache-Control + immutable dist headers
 *
 * Usage:
 *   node scripts/test-cloud-app-host-phases-2-4-e2e.mjs
 *   node scripts/test-cloud-app-host-phases-2-4-e2e.mjs --memory=http://127.0.0.1:5001 --host=http://localhost:8787
 *   node scripts/test-cloud-app-host-phases-2-4-e2e.mjs --share-token=TOKEN --app-id=UUID
 *
 * Env (.env.local): PAPR_CLOUD_APP_HOST_KEY (required)
 * Optional: PAPR_SHARE_TOKEN, CLOUD_APP_HOST_GCS_BUCKET (Phase 3 warm)
 */

import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

loadEnvLocal();

const memoryBase = (arg("memory") ?? process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001").replace(/\/$/, "");
const hostBase = (arg("host") ?? "http://localhost:8787").replace(/\/$/, "");
const namespaceId = arg("namespace") ?? "85ZIB7mD1V";
const slug = arg("slug") ?? "joe-coffee-intelligence";
const appId = arg("app-id") ?? "744f60d6-d57b-4be7-95fd-feb7115831b4";
const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
const shareToken = arg("share-token") ?? process.env.PAPR_SHARE_TOKEN ?? "WH1aPTAdXxIlw1ZY2qjzbp30TtNT8qUXPwou4mYkEvI";
const gcsBucket = process.env.CLOUD_APP_HOST_GCS_BUCKET;

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${YELLOW}SKIP${RESET} ${name} — ${reason}`);
  skipped++;
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text, headers: resp.headers };
}

function runtimeBody(extra = {}) {
  return JSON.stringify({
    namespaceId,
    slug,
    shareToken,
    ...extra,
  });
}

function hostHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "X-Papr-Share-Token": shareToken,
    "X-Papr-Namespace-Id": namespaceId,
    "X-Papr-Slug": slug,
    "Cache-Control": "max-age=0",
    ...extra,
  };
}

function memoryHostHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": hostKey,
  };
}

async function fetchRepoFile(relativePath) {
  return fetchJson(`${memoryBase}/v1/cloud/apps/runtime/repo-file`, {
    method: "POST",
    headers: memoryHostHeaders(),
    body: runtimeBody({ relativePath }),
  });
}

/** Resolve first Turso short name allowed for this app. */
async function resolveLinkedTursoName() {
  const linked = await fetchRepoFile("linked-databases.json");
  if (linked.status === 200 && linked.data?.content) {
    const registry = JSON.parse(linked.data.content);
    const records = registry.records
      ?? (registry.databases ? Object.values(registry.databases) : []);
    for (const record of records) {
      if (typeof record?.tursoShortName === "string" && record.tursoShortName.trim()) {
        return record.tursoShortName.trim();
      }
    }
  }

  const ds = await fetchRepoFile("data-sources.json");
  if (ds.status === 200 && ds.data?.content) {
    const config = JSON.parse(ds.data.content);
    for (const source of config.sources ?? []) {
      if (source.jobId) {
        return `j-${String(source.jobId).replace(/-/g, "").slice(0, 8)}`;
      }
      if (source.dbId) {
        return `d-${String(source.dbId).replace(/^db-/, "").slice(0, 8)}`;
      }
    }
  }
  return null;
}

async function testPhase2DbToken(database) {
  console.log(`\n${BOLD}--- Phase 2: Memory db-token cache (${database}) ---${RESET}`);
  const body = runtimeBody({ database });
  const headers = memoryHostHeaders();

  const t0 = performance.now();
  const r1 = await fetchJson(`${memoryBase}/v1/cloud/apps/runtime/db-token`, {
    method: "POST",
    headers,
    body,
  });
  const t1 = performance.now();
  const r2 = await fetchJson(`${memoryBase}/v1/cloud/apps/runtime/db-token`, {
    method: "POST",
    headers,
    body,
  });
  const t2 = performance.now();

  const call1Ms = Math.round(t1 - t0);
  const call2Ms = Math.round(t2 - t1);

  if (r1.status !== 200) {
    check("db-token first call → 200", false, `status=${r1.status} ${r1.text.slice(0, 160)}`);
    return;
  }

  check("db-token first call → 200", true, `${call1Ms}ms`);
  check("db-token returns expiresAt", Boolean(r1.data?.expiresAt), r1.data?.expiresAt ?? "missing");
  check("db-token returns authToken", Boolean(r1.data?.authToken));
  check("db-token second call → 200", r2.status === 200, `status=${r2.status}`);
  check("memory cache hit (same authToken)", r1.data.authToken === r2.data.authToken);
  check(
    "second db-token call faster",
    call2Ms <= call1Ms,
    `${call1Ms}ms → ${call2Ms}ms`,
  );
}

async function testPhase2HostDbQuery() {
  console.log(`\n${BOLD}--- Phase 2: Host /api/db/query (Turso token path) ---${RESET}`);
  const res = await fetchJson(`${hostBase}/api/db/query`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({
      appId,
      sourceId: "default",
      sql: "SELECT 1 AS ok",
    }),
  });

  if (res.status === 503 && res.data?.code === "schema_syncing") {
    skip("host db query", `schema syncing (${res.data.requiredSchemaVersion ?? "unknown"})`);
    return;
  }
  if (res.status === 404 || res.status === 400) {
    skip("host db query", `status=${res.status} ${res.text.slice(0, 120)}`);
    return;
  }

  check("POST /api/db/query → 200", res.status === 200, `status=${res.status} ${res.text.slice(0, 120)}`);
  if (res.status === 200) {
    check("query returns rows", Array.isArray(res.data?.rows) || res.data?.ok === true, JSON.stringify(res.data).slice(0, 80));
  }
}

async function testPhase2BackendAction() {
  console.log(`\n${BOLD}--- Phase 2: Backend artifact cache (repeat action) ---${RESET}`);
  const manifest = await fetchRepoFile("backend/manifest.json");
  if (manifest.status !== 200) {
    skip("backend action", "no backend/manifest.json in published repo");
    return;
  }

  let actionName;
  try {
    const parsed = JSON.parse(manifest.data.content);
    actionName = Object.keys(parsed.actions ?? {})[0];
  } catch {
    skip("backend action", "invalid manifest JSON");
    return;
  }
  if (!actionName) {
    skip("backend action", "manifest has no actions");
    return;
  }

  const url = `${hostBase}/api/app/backend/${actionName}`;
  const body = JSON.stringify({ appId, params: { e2e: "phases-2-4" } });
  const headers = hostHeaders();

  const t0 = performance.now();
  const r1 = await fetch(url, { method: "POST", headers, body });
  const b1 = await r1.json().catch(() => ({}));
  const t1 = performance.now();

  const t2 = performance.now();
  const r2 = await fetch(url, { method: "POST", headers, body });
  const b2 = await r2.json().catch(() => ({}));
  const t3 = performance.now();

  const call1Ms = Math.round(t1 - t0);
  const call2Ms = Math.round(t3 - t2);

  check(`POST /api/app/backend/${actionName} → 200`, r1.status === 200, `status=${r1.status} ${JSON.stringify(b1).slice(0, 120)}`);
  if (r1.status === 200) {
    check("handler exitCode === 0", b1.exitCode === 0, `exit=${b1.exitCode}`);
    check("second backend call → 200", r2.status === 200, `status=${r2.status}`);
    check(
      "second backend call not slower",
      call2Ms <= call1Ms * 1.5,
      `${call1Ms}ms → ${call2Ms}ms`,
    );
  }
}

async function testPhase3RevisionNotify() {
  console.log(`\n${BOLD}--- Phase 3: Revision notify + deploy snapshot warm ---${RESET}`);
  const notify = await fetchJson(`${hostBase}/internal/app-revision-updated`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-App-Host-Key": hostKey,
    },
    body: JSON.stringify({ namespaceId, slug }),
  });
  check("POST /internal/app-revision-updated → 200", notify.status === 200, notify.text.slice(0, 120));
  check("cacheInvalidated in response", notify.data?.cacheInvalidated === true);

  if (!gcsBucket) {
    skip("GCS deploy snapshot warm", "CLOUD_APP_HOST_GCS_BUCKET not set (expected locally)");
    return;
  }

  // Allow async warm to finish
  await new Promise((r) => setTimeout(r, 3000));

  const revisionRes = await fetchJson(
    `${hostBase}/${namespaceId}/${slug}/__papr__/app-revision.json`,
    { headers: hostHeaders() },
  );
  if (revisionRes.status !== 200) {
    skip("deploy snapshot verify", `revision endpoint status=${revisionRes.status}`);
    return;
  }
  const revision = revisionRes.data?.revision;
  if (!revision) {
    skip("deploy snapshot verify", "no revision in app-revision.json");
    return;
  }

  // Second page load should hit deploy snapshot path (observable as stable fast load)
  const t0 = performance.now();
  await fetch(`${hostBase}/${namespaceId}/${slug}/dist/app.js`, { headers: hostHeaders() });
  const ms = Math.round(performance.now() - t0);
  check(`dist/app.js after warm (${ms}ms)`, ms < 2000, "post-warm fetch");
}

async function testPhase4CdnHeaders() {
  console.log(`\n${BOLD}--- Phase 4: Edge cache headers ---${RESET}`);
  const res = await fetch(`${hostBase}/${namespaceId}/${slug}/dist/app.js`, {
    headers: hostHeaders(),
  });
  check("GET dist/app.js → 200", res.ok, `status=${res.status}`);
  const cc = res.headers.get("cache-control") ?? "";
  const cdn = res.headers.get("cdn-cache-control") ?? "";
  check("Cache-Control immutable", cc.includes("immutable"), cc);
  check("CDN-Cache-Control immutable", cdn.includes("immutable"), cdn || "(missing — restart cloud app host)");
}

async function testPageCache() {
  console.log(`\n${BOLD}--- Cache: repeat page load ---${RESET}`);
  const path = `/${namespaceId}/${slug}/`;
  const headers = hostHeaders();

  const t0 = performance.now();
  const p1 = await fetch(`${hostBase}${path}`, { headers, redirect: "follow" });
  await p1.text();
  const p1ms = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const p2 = await fetch(`${hostBase}${path}`, { headers, redirect: "follow" });
  await p2.text();
  const p2ms = Math.round(performance.now() - t1);

  check("page load 1 → 200", p1.ok, `${p1ms}ms`);
  check("page load 2 → 200", p2.ok, `${p2ms}ms`);
  check("second page load faster", p2ms <= p1ms, `${p1ms}ms → ${p2ms}ms`);
}

async function main() {
  console.log(`\n${BOLD}${CYAN}Cloud App Host Phases 2–4 E2E${RESET}`);
  console.log(`Memory: ${memoryBase}`);
  console.log(`Host:   ${hostBase}`);
  console.log(`App:    ${namespaceId}/${slug} (${appId})`);
  console.log(`GCS:    ${gcsBucket ?? "(not set)"}`);
  console.log("=".repeat(60));

  if (!hostKey) {
    console.error(`${RED}PAPR_CLOUD_APP_HOST_KEY required in .env.local${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Prerequisites ---${RESET}`);
  try {
    const memHealth = await fetchJson(`${memoryBase}/health`);
    check("memory /health", memHealth.status === 200, `status=${memHealth.status}`);
  } catch (err) {
    check("memory reachable", false, err.message);
    process.exit(1);
  }

  try {
    const hostHealth = await fetchJson(`${hostBase}/health`);
    check("cloud app host /health", hostHealth.status === 200);
    check("service=cloud-app-host", hostHealth.data?.service === "cloud-app-host");
  } catch (err) {
    check("cloud app host reachable", false, err.message);
    process.exit(1);
  }

  const access = await fetchJson(`${memoryBase}/v1/cloud/apps/access/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: runtimeBody(),
  });
  check("access/validate → 200", access.status === 200, access.text.slice(0, 120));

  const tursoName = await resolveLinkedTursoName();
  if (tursoName) {
    await testPhase2DbToken(tursoName);
  } else {
    skip("Phase 2 db-token", "could not resolve linked Turso name from repo");
  }

  await testPhase2HostDbQuery();
  await testPhase2BackendAction();
  await testPhase3RevisionNotify();
  await testPhase4CdnHeaders();
  await testPageCache();

  console.log("\n" + "=".repeat(60));
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${failed ? RED + failed + " failed" + RESET : "0 failed"}, ${YELLOW}${skipped} skipped${RESET}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
