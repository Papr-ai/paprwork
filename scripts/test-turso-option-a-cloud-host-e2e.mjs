#!/usr/bin/env node
/**
 * Option A — Cloud App Host + Memory runtime allowlist (owner vs visitor).
 *
 * Exercises the server boundary that `runtime_db_token` enforces: publisher may
 * mint the per-user *base* name; visitors get their own `-u-{uid8}` copy and
 * cannot request the base.
 *
 * This is HTTP-only (Memory db-token + optional host health). True two-browser
 * sessions (cookies + iframe `/api/db/query`) are a follow-up harness — use
 * `--browser` to attempt Playwright when installed.
 *
 * Prerequisites:
 *   - Memory with cloud routes (local or memory.papr.ai)
 *   - PAPR_CLOUD_APP_HOST_KEY in .env.local
 *   - Published throwaway app with at least one linked **per-user** database
 *
 * Usage:
 *   npm run test:turso-option-a-cloud-host-e2e
 *   node scripts/test-turso-option-a-cloud-host-e2e.mjs \
 *     --app-id=<throwaway-uuid> \
 *     --namespace=<ns> \
 *     --slug=<slug> \
 *     --publisher-user=<parse-user-id> \
 *     --visitor-user=<other-parse-user-id> \
 *     [--share-token=...] \
 *     [--memory=http://127.0.0.1:5001] \
 *     [--host=http://localhost:8787]
 *
 * Env: PAPR_API_KEY (owner / namespace key), PAPR_SHARE_TOKEN (visitor link)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

loadEnvLocal();

const memoryBase = (arg("memory") ?? process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001").replace(
  /\/$/,
  "",
);
const hostBase = (arg("host") ?? "http://localhost:8787").replace(/\/$/, "");
const namespaceId = arg("namespace");
const slug = arg("slug");
const appId = arg("app-id");
const publisherUser = arg("publisher-user");
const visitorUser = arg("visitor-user");
const shareToken = arg("share-token") ?? process.env.PAPR_SHARE_TOKEN ?? "";
const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
const apiKey = process.env.PAPR_API_KEY?.trim();
const tryBrowser = args.includes("--browser");

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

function normalizeUserId(userId) {
  return userId.replace(/-/g, "").trim().toLowerCase();
}

function dbTursoShortName(dbId) {
  const raw = String(dbId).replace(/^db-/, "").replace(/-/g, "");
  const id8 = raw.slice(0, 8).toLowerCase();
  return `d-${id8}`;
}

/** Option A naming (parity with memory `resolve_turso_short_name`). */
function perUserTursoName(dbId, userId, publisherUserId) {
  const base = dbTursoShortName(dbId);
  if (normalizeUserId(userId) === normalizeUserId(publisherUserId)) {
    return base;
  }
  const uid8 = userId.replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${base}-u-${uid8}`;
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
  return { status: resp.status, data, text };
}

function runtimeBody(extra = {}) {
  return JSON.stringify({
    namespaceId,
    slug,
    shareToken: shareToken || undefined,
    ...extra,
  });
}

function memoryHostHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": hostKey ?? "",
  };
}

async function fetchRepoFile(relativePath) {
  return fetchJson(`${memoryBase}/v1/cloud/apps/runtime/repo-file`, {
    method: "POST",
    headers: memoryHostHeaders(),
    body: runtimeBody({ relativePath }),
  });
}

async function runtimeDbToken(database, { externalUserId, paprApiKey, shareToken: tokenOverride }) {
  const body = {
    namespaceId,
    slug,
    database,
    external_user_id: externalUserId,
  };
  if (paprApiKey) body.papr_api_key = paprApiKey;
  if (tokenOverride ?? shareToken) body.share_token = tokenOverride ?? shareToken;

  return fetchJson(`${memoryBase}/v1/cloud/apps/runtime/db-token`, {
    method: "POST",
    headers: memoryHostHeaders(),
    body: JSON.stringify(body),
  });
}

/** @returns {{ dbId: string, base: string, visitorName: string } | null} */
async function resolvePerUserLinkedDb() {
  const dbJson = await fetchRepoFile("databases.json");
  let registry = null;
  if (dbJson.status === 200 && dbJson.data?.content) {
    try {
      registry = JSON.parse(dbJson.data.content);
    } catch {
      registry = null;
    }
  }

  const records = registry?.databases
    ? Object.values(registry.databases)
    : registry?.records ?? [];

  for (const rec of records) {
    if (rec?.isolation !== "per-user") continue;
    const dbId = rec.dbId ?? rec.id;
    if (!dbId) continue;
    const base = dbTursoShortName(dbId);
    const visitorName = perUserTursoName(dbId, visitorUser, publisherUser);
    return { dbId: String(dbId), base, visitorName };
  }

  const linked = await fetchRepoFile("linked-databases.json");
  if (linked.status !== 200 || !linked.data?.content) return null;
  let linkedDoc;
  try {
    linkedDoc = JSON.parse(linked.data.content);
  } catch {
    return null;
  }
  const linkedRecords = linkedDoc?.records ?? (linkedDoc?.databases ? Object.values(linkedDoc.databases) : []);
  for (const rec of linkedRecords) {
    if (rec?.isolation !== "per-user") continue;
    const dbId = rec.dbId ?? rec.id;
    if (!dbId) continue;
    const base = dbTursoShortName(dbId);
    const visitorName = perUserTursoName(dbId, visitorUser, publisherUser);
    return { dbId: String(dbId), base, visitorName };
  }

  const ds = await fetchRepoFile("data-sources.json");
  if (ds.status === 200 && ds.data?.content && registry?.databases) {
    let config;
    try {
      config = JSON.parse(ds.data.content);
    } catch {
      return null;
    }
    for (const source of config.sources ?? []) {
      const dbId = source.dbId;
      if (!dbId) continue;
      const rec = registry.databases[dbId];
      if (rec?.isolation !== "per-user") continue;
      const base = dbTursoShortName(dbId);
      const visitorName = perUserTursoName(dbId, visitorUser, publisherUser);
      return { dbId: String(dbId), base, visitorName };
    }
  }

  return null;
}

async function runMemoryDbTokenMatrix(perUser) {
  console.log(`\n${BOLD}--- Memory runtime/db-token (Option A) ---${RESET}`);
  console.log(`  per-user db: ${perUser.dbId}`);
  console.log(`  publisher base: ${perUser.base}`);
  console.log(`  visitor copy:   ${perUser.visitorName}\n`);

  const ownerBase = await runtimeDbToken(perUser.base, {
    externalUserId: publisherUser,
    paprApiKey: apiKey,
  });
  check(
    "owner → base name → 200",
    ownerBase.status === 200,
    `status=${ownerBase.status} ${ownerBase.text.slice(0, 160)}`,
  );

  const ownerVisitorName = await runtimeDbToken(perUser.visitorName, {
    externalUserId: publisherUser,
    paprApiKey: apiKey,
  });
  check(
    "owner → visitor suffix name → 403",
    ownerVisitorName.status === 403,
    `status=${ownerVisitorName.status} (expected forbidden)`,
  );

  const visitorBase = await runtimeDbToken(perUser.base, {
    externalUserId: visitorUser,
    paprApiKey: shareToken ? undefined : apiKey,
    shareToken: shareToken || undefined,
  });
  check(
    "visitor → base name → 403",
    visitorBase.status === 403,
    `status=${visitorBase.status} ${visitorBase.text.slice(0, 120)}`,
  );

  const visitorCopy = await runtimeDbToken(perUser.visitorName, {
    externalUserId: visitorUser,
    paprApiKey: shareToken ? undefined : apiKey,
    shareToken: shareToken || undefined,
  });
  check(
    "visitor → own suffix name → 200",
    visitorCopy.status === 200,
    `status=${visitorCopy.status} ${visitorCopy.text.slice(0, 160)}`,
  );

  if (!shareToken) {
    skip("visitor auth via share token", "pass --share-token or PAPR_SHARE_TOKEN to test link-only visitor");
  }
}

async function runHostHealth() {
  console.log(`\n${BOLD}--- Cloud App Host (health only) ---${RESET}`);
  try {
    const health = await fetch(`${hostBase}/health`);
    check("host /health", health.ok, `HTTP ${health.status}`);
  } catch (err) {
    check("host /health", false, err instanceof Error ? err.message : String(err));
  }
}

async function runBrowserHarness() {
  console.log(`\n${BOLD}--- Browser (owner vs visitor) ---${RESET}`);
  if (!tryBrowser) {
    skip("playwright two-session", "pass --browser (not implemented yet — use Memory matrix above)");
    return;
  }
  skip(
    "playwright two-session",
    "stub: open owner + visitor contexts against host iframe /api/db/query (track in follow-up PR)",
  );
}

function printUsageAndExit(code = 1) {
  console.error(`
${BOLD}Option A cloud host E2E${RESET}

Required:
  --app-id=<uuid>           throwaway published app (never omit)
  --namespace=<id>
  --slug=<slug>
  --publisher-user=<id>     Parse user id of app owner
  --visitor-user=<id>       different user id (teammate or link visitor)

Env:
  PAPR_CLOUD_APP_HOST_KEY   host → memory auth
  PAPR_API_KEY              owner db-token calls
  PAPR_SHARE_TOKEN          optional visitor link auth

Example:
  node scripts/test-turso-option-a-cloud-host-e2e.mjs \\
    --app-id=... --namespace=... --slug=... \\
    --publisher-user=WkPutXGdqg --visitor-user=l6UFSw9m4T
`);
  process.exit(code);
}

async function main() {
  if (!appId || !namespaceId || !slug || !publisherUser || !visitorUser) {
    printUsageAndExit();
  }
  if (!hostKey) {
    console.error(`${RED}PAPR_CLOUD_APP_HOST_KEY required (see .env.local)${RESET}`);
    process.exit(1);
  }
  if (!apiKey && !shareToken) {
    console.error(`${RED}PAPR_API_KEY and/or PAPR_SHARE_TOKEN required${RESET}`);
    process.exit(1);
  }
  if (normalizeUserId(publisherUser) === normalizeUserId(visitorUser)) {
    console.error(`${RED}--visitor-user must differ from --publisher-user${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}Option A — Cloud host E2E${RESET}`);
  console.log(`App:       ${appId}`);
  console.log(`Route:     ${namespaceId}/${slug}`);
  console.log(`Publisher: ${publisherUser}`);
  console.log(`Visitor:   ${visitorUser}`);
  console.log(`Memory:    ${memoryBase}`);
  console.log(`Host:      ${hostBase}`);
  console.log("=".repeat(60));

  try {
    const memHealth = await fetch(`${memoryBase}/health`);
    check("memory /health", memHealth.ok, `HTTP ${memHealth.status}`);
  } catch (err) {
    check("memory /health", false, err instanceof Error ? err.message : String(err));
    console.log(`\nStart memory or set --memory=\n`);
    process.exit(1);
  }

  const perUser = await resolvePerUserLinkedDb();
  if (!perUser) {
    check("find per-user linked database in repo", false, "no per-user source in databases.json / linked-databases.json");
  } else {
    check("find per-user linked database in repo", true, `${perUser.dbId} → ${perUser.base}`);
    await runMemoryDbTokenMatrix(perUser);
  }

  await runHostHealth();
  await runBrowserHarness();

  console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
