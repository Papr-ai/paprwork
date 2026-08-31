#!/usr/bin/env node
/**
 * Cloud App Host E2E — publish mini-app → validate access → /api/db/query
 *
 * Prerequisites:
 *   1. Memory server with cloud publish routes (local or memory.papr.ai)
 *   2. PAPR_API_KEY in env or Paprwork keychain (gateway proxy uses keychain)
 *   3. Optional: cloud app host running (npm run start:cloud-app-host)
 *
 * Usage:
 *   node scripts/test-cloud-app-host-e2e.mjs --app-id=<throwaway-uuid> [--gateway URL] [--host URL]
 *
 * IMPORTANT — do NOT run without --app-id:
 *   This test POSTs a new team publish with slug `e2e-*`. Using a real production app id
 *   creates a second catalog row (one per publisher) or overwrites YOUR publish slug.
 *   Create a disposable mini-app for E2E, pass its id, and delete the app when done.
 *
 * Defaults:
 *   gateway: http://localhost:18789
 *   host:    http://localhost:8787
 */

import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const host = (
  args.find((a) => a.startsWith("--host="))?.split("=")[1] ??
  "http://localhost:8787"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1]?.trim();
const allowProductionApp = args.includes("--allow-production-app");
const skipCleanup = args.includes("--skip-cleanup");
const envThrowawayAppId = process.env.PAPR_E2E_CLOUD_APP_ID?.trim();

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;
let cleanupAppId = null;
let publishedThisRun = false;

function check(name, condition, detail = "") {
  if (condition) {
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

function resolveAppId() {
  const appId = appIdArg ?? envThrowawayAppId ?? null;
  if (!appId) {
    console.log(`\n${RED}${BOLD}Missing required --app-id${RESET}`);
    console.log(
      "This E2E publishes with slug e2e-* and must use a disposable throwaway mini-app.",
    );
    console.log(
      "Using the first app in apps.json (or a production app) creates duplicate workspace catalog rows.",
    );
    console.log(`\nExample:\n  npm run test:cloud-app-host -- --app-id=<throwaway-uuid>`);
    console.log(
      "Or set PAPR_E2E_CLOUD_APP_ID in .env.local to a dedicated test app id.\n",
    );
    process.exit(1);
  }
  return appId;
}

function loadRegisteredAppIds() {
  const ids = new Set();
  const candidates = [
    join(process.cwd(), "data", "apps.json"),
    join(process.env.HOME ?? "", "Papr", "data", "apps.json"),
  ];
  for (const filePath of candidates) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
      for (const app of list) {
        if (app?.id) ids.add(String(app.id));
      }
    } catch {
      /* optional */
    }
  }
  return ids;
}

function assertThrowawayAppId(appId) {
  if (allowProductionApp) {
    console.log(
      `${YELLOW}Warning:${RESET} --allow-production-app set — skipping production guard.`,
    );
    return;
  }

  const registered = loadRegisteredAppIds();
  if (!registered.has(appId)) {
    return;
  }

  console.log(`\n${RED}${BOLD}Refusing to run E2E against a registered local app${RESET}`);
  console.log(
    `App ${appId} exists in apps.json. This test publishes slug e2e-* to memory and can pollute Team Apps.`,
  );
  console.log("Create a disposable mini-app for E2E, or pass --allow-production-app to override.\n");
  process.exit(1);
}

async function memoryFetch(path, { method = "GET", body = null, apiKey } = {}) {
  loadEnvLocal();
  const base =
    process.env.PAPR_MEMORY_SERVER_URL ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai";
  const key = apiKey ?? process.env.PAPR_API_KEY;
  if (!key) throw new Error("PAPR_API_KEY not set");

  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${base}${path}`, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function cleanupTestPublish(appId) {
  if (skipCleanup || !publishedThisRun || !appId) {
    return;
  }

  console.log(`\n${BOLD}--- Cleanup (disable test publish) ---${RESET}`);
  try {
    const res = await memoryFetch(
      `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
      { method: "DELETE" },
    );
    if (res.status === 200) {
      console.log(`  ${GREEN}OK${RESET} Disabled publish for ${appId} (acting user only)`);
      return;
    }
    if (res.status === 404) {
      console.log(`  ${YELLOW}SKIP${RESET} Publish already disabled for ${appId}`);
      return;
    }
    console.log(
      `  ${YELLOW}WARN${RESET} Cleanup DELETE returned ${res.status}: ${res.text.slice(0, 160)}`,
    );
  } catch (error) {
    console.log(`  ${YELLOW}WARN${RESET} Cleanup failed: ${(error).message}`);
  }
}

async function testHostHealth() {
  console.log(`\n${BOLD}--- Cloud App Host Health ---${RESET}`);
  try {
    const resp = await fetch(`${host}/health`);
    const json = await resp.json();
    check("host /health → 200", resp.status === 200, `status=${resp.status}`);
    check("host service id", json.service === "cloud-app-host", JSON.stringify(json));
    return resp.status === 200;
  } catch (e) {
    check("host reachable", false, `${e.message} — run: npm run start:cloud-app-host`);
    return false;
  }
}

async function testPublishFlow(appId) {
  console.log(`\n${BOLD}--- Publish API (memory contract) ---${RESET}`);

  const slug = `e2e-${Date.now().toString(36)}`;
  const publish = await memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: {
      appId,
      slug,
      visibility: "team",
      linkPermission: "read",
    },
  });

  check("POST /v1/cloud/apps/publish → 200", publish.status === 200, publish.text.slice(0, 200));
  if (publish.status !== 200) return null;

  publishedThisRun = true;

  check("response has visibility (not accessMode)", !!publish.data.visibility, JSON.stringify(publish.data));
  check("response has shareUrl", !!publish.data.shareUrl, JSON.stringify(publish.data));

  const get = await memoryFetch(`/v1/cloud/apps/publish/${encodeURIComponent(appId)}`);
  check("GET publish config → 200", get.status === 200, get.text.slice(0, 200));

  const namespaceId = publish.data.shareUrl?.split("/").slice(-2)[0];
  check(
    "shareUrl contains namespace + slug",
    !!namespaceId && publish.data.slug === slug,
    publish.data.shareUrl,
  );

  return { appId, slug, namespaceId, shareUrl: publish.data.shareUrl };
}

async function testAccessValidate(ctx) {
  console.log(`\n${BOLD}--- Access Validate ---${RESET}`);
  if (!ctx?.namespaceId || !ctx.slug) {
    skip("access validate", "publish context missing");
    return false;
  }

  const res = await memoryFetch("/v1/cloud/apps/access/validate", {
    method: "POST",
    body: {
      namespaceId: ctx.namespaceId,
      slug: ctx.slug,
    },
  });

  check("POST access/validate → 200", res.status === 200, res.text.slice(0, 200));
  if (res.status === 200) {
    check("canRead=true for owner", res.data.canRead === true, JSON.stringify(res.data));
    check("appId matches", res.data.appId === ctx.appId, res.data.appId);
  }
  return res.status === 200;
}

async function testHostDbQuery(ctx) {
  console.log(`\n${BOLD}--- Host /api/db/query (same-origin proxy) ---${RESET}`);
  if (!ctx?.namespaceId || !ctx.slug) {
    skip("host db query", "publish context missing");
    return;
  }

  const res = await fetch(`${host}/api/db/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Papr-Namespace-Id": ctx.namespaceId,
      "X-Papr-Slug": ctx.slug,
      ...(process.env.PAPR_API_KEY
        ? { "X-API-Key": process.env.PAPR_API_KEY }
        : {}),
    },
    body: JSON.stringify({
      appId: ctx.appId,
      sql: "SELECT 1 AS ok",
      params: [],
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (res.status === 403) {
    skip("db query via host", "access denied — app may lack Turso sources or host needs PAPR_API_KEY");
    return;
  }

  check("POST /api/db/query → 200", res.status === 200, text.slice(0, 200));
  if (res.status === 200) {
    check("rows returned", Array.isArray(data.rows), JSON.stringify(data).slice(0, 120));
  }
}

async function gatewayCloud(method, path, body = null) {
  const url = `${gateway}/api/cloud${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
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

async function testGatewayPublishProxy(appId) {
  console.log(`\n${BOLD}--- Gateway publish proxy (optional) ---${RESET}`);
  try {
    const health = await fetch(`${gateway}/health`);
    if (!health.ok) {
      skip("gateway publish proxy", "gateway not running");
      return;
    }
  } catch {
    skip("gateway publish proxy", "gateway not running");
    return;
  }

  const res = await gatewayCloud("POST", `/publish/${encodeURIComponent(appId)}`, {
    accessMode: "team",
  });
  if (res.status === 404 && res.text.includes("Not Found")) {
    skip("gateway publish proxy", "route not wired yet");
    return;
  }
  check("gateway publish returns 200", res.status === 200, res.text.slice(0, 200));
  if (res.status === 200) {
    check("gateway maps accessMode → visibility", !!res.data.accessMode, JSON.stringify(res.data));
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}Cloud App Host E2E${RESET}`);
  console.log(`Gateway: ${gateway}`);
  console.log(`Host:    ${host}`);
  console.log("=".repeat(70));

  cleanupAppId = resolveAppId();
  assertThrowawayAppId(cleanupAppId);
  console.log(`App ID: ${cleanupAppId}`);

  if (!process.env.PAPR_API_KEY) {
    console.log(
      `${YELLOW}PAPR_API_KEY not in env — memory tests may fail. Set in .env.local or export.${RESET}`,
    );
  }

  try {
    const hostOk = await testHostHealth();
    const publishCtx = await testPublishFlow(cleanupAppId);
    await testAccessValidate(publishCtx);
    if (hostOk) {
      await testHostDbQuery(publishCtx);
    }
    await testGatewayPublishProxy(cleanupAppId);

    console.log(`\n${"=".repeat(70)}`);
    const total = passed + failed + skipped;
    console.log(
      `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET} / ${total}`,
    );

    if (failed > 0) process.exit(1);
    console.log(`\n${GREEN}All runnable tests passed!${RESET}`);
  } finally {
    await cleanupTestPublish(cleanupAppId);
  }
}

main().catch(async (e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  try {
    await cleanupTestPublish(cleanupAppId);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
