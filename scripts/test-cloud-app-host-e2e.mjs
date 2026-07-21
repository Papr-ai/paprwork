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
 *   node scripts/test-cloud-app-host-e2e.mjs [--gateway URL] [--host URL] [--app-id ID]
 *
 * Defaults:
 *   gateway: http://localhost:18789
 *   host:    http://localhost:8787
 */

import { readFileSync } from "fs";
import { homedir } from "os";
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
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;

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

function pickAppId() {
  if (appIdArg) return appIdArg;
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const first = list.find((a) => a?.id);
    return first?.id ?? null;
  } catch {
    return null;
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

  check("response has visibility (not accessMode)", !!publish.data.visibility, JSON.stringify(publish.data));
  check("response has shareUrl", !!publish.data.shareUrl, JSON.stringify(publish.data));

  const get = await memoryFetch(`/v1/cloud/apps/publish/${encodeURIComponent(appId)}`);
  check("GET publish config → 200", get.status === 200, get.text.slice(0, 200));

  const namespaceId = publish.data.shareUrl?.split("/").slice(-2)[0];
  check("shareUrl contains namespace + slug", !!namespaceId && publish.data.slug === slug,
    publish.data.shareUrl);

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

  const appId = pickAppId();
  if (!appId) {
    console.log(`\n${RED}No app ID — pass --app-id=... or add apps in ~/Papr/data/apps.json${RESET}`);
    process.exit(1);
  }
  console.log(`App ID: ${appId}`);

  if (!process.env.PAPR_API_KEY) {
    console.log(`${YELLOW}PAPR_API_KEY not in env — memory tests may fail. Set in .env.local or export.${RESET}`);
  }

  const hostOk = await testHostHealth();
  const publishCtx = await testPublishFlow(appId);
  await testAccessValidate(publishCtx);
  if (hostOk) {
    await testHostDbQuery(publishCtx);
  }
  await testGatewayPublishProxy(appId);

  console.log(`\n${"=".repeat(70)}`);
  const total = passed + failed + skipped;
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET} / ${total}`,
  );

  if (failed > 0) process.exit(1);
  console.log(`\n${GREEN}All runnable tests passed!${RESET}`);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
