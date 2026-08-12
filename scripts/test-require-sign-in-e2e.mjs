#!/usr/bin/env node
/**
 * E2E: public_read + requireSignIn on local memory server (and optional gateway).
 *
 * Prerequisites:
 *   - Memory server running with requireSignIn support (restart after pulling memory changes)
 *   - PAPR_API_KEY in .env.local
 *
 * Usage:
 *   node scripts/test-require-sign-in-e2e.mjs [--memory URL] [--gateway URL] [--cleanup]
 *
 * Optional gateway (npm start): verifies POST/GET /api/cloud/publish with requireSignIn + perUserIsolation.
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const cleanup = args.includes("--cleanup");

function arg(name, fallback) {
  return args.find((a) => a.startsWith(`${name}=`))?.split("=")[1] ?? fallback;
}

const memoryBase = arg("memory", "http://127.0.0.1:8000").replace(/\/$/, "");
const gateway = arg("gateway", "http://localhost:18789").replace(/\/$/, "");

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

async function memoryFetch(path, { method = "GET", body = null, apiKey = null } = {}) {
  const key = apiKey ?? process.env.PAPR_API_KEY;
  if (!key) throw new Error("PAPR_API_KEY not set — add to .env.local");
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${memoryBase}${path}`, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

function parseShareUrl(shareUrl) {
  const parts = shareUrl.replace(/\/$/, "").split("/");
  const slug = parts.at(-1);
  const namespaceId = parts.at(-2);
  return { namespaceId, slug };
}

async function testMemoryRequireSignIn() {
  console.log(`\n${BOLD}--- Memory: public_read + requireSignIn ---${RESET}`);

  const appId = randomUUID();
  const slug = `e2e-reqsign-${Date.now().toString(36)}`;

  const publish = await memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: {
      appId,
      slug,
      visibility: "public_read",
      linkPermission: "read",
      codeAccess: "off",
      requireSignIn: true,
    },
  });

  check("POST publish → 200", publish.status === 200, publish.text.slice(0, 240));
  if (publish.status !== 200) return null;

  const { namespaceId } = parseShareUrl(publish.data.shareUrl ?? "");
  check("shareUrl parsed namespace + slug", !!namespaceId && publish.data.slug === slug, publish.data.shareUrl);

  const get = await memoryFetch(`/v1/cloud/apps/publish/${encodeURIComponent(appId)}`);
  check("GET publish → 200", get.status === 200, get.text.slice(0, 200));
  check(
    "GET returns requireSignIn=true",
    get.data.requireSignIn === true,
    JSON.stringify({ requireSignIn: get.data.requireSignIn }),
  );

  const resolve = await memoryFetch(
    `/v1/cloud/apps/resolve/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}`,
  );
  check("resolve → 200", resolve.status === 200, resolve.text.slice(0, 200));
  check(
    "resolve returns requireSignIn=true",
    resolve.data.requireSignIn === true,
    JSON.stringify({ requireSignIn: resolve.data.requireSignIn }),
  );

  const anonValidate = await fetch(`${memoryBase}/v1/cloud/apps/access/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceId, slug }),
  });
  check(
    "anonymous access/validate → 403",
    anonValidate.status === 403,
    `status=${anonValidate.status}`,
  );

  const authedValidate = await memoryFetch("/v1/cloud/apps/access/validate", {
    method: "POST",
    body: { namespaceId, slug },
  });
  check("authed access/validate → 200", authedValidate.status === 200, authedValidate.text.slice(0, 200));
  check(
    "authed canRead=true",
    authedValidate.data?.canRead === true,
    JSON.stringify(authedValidate.data),
  );

  // Turn off requireSignIn — anonymous should work again
  const publishOpen = await memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: {
      appId,
      slug,
      visibility: "public_read",
      linkPermission: "read",
      requireSignIn: false,
    },
  });
  check("republish requireSignIn=false → 200", publishOpen.status === 200, publishOpen.text.slice(0, 200));

  const getOpen = await memoryFetch(`/v1/cloud/apps/publish/${encodeURIComponent(appId)}`);
  check(
    "GET after clear: requireSignIn absent/false",
    getOpen.data.requireSignIn !== true,
    JSON.stringify({ requireSignIn: getOpen.data.requireSignIn }),
  );

  const anonOpen = await fetch(`${memoryBase}/v1/cloud/apps/access/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceId, slug }),
  });
  check(
    "anonymous access after clear → 200",
    anonOpen.status === 200,
    `status=${anonOpen.status}`,
  );

  if (cleanup) {
    const del = await memoryFetch(`/v1/cloud/apps/publish/${encodeURIComponent(appId)}`, {
      method: "DELETE",
    });
    check("cleanup DELETE publish → 200", del.status === 200, del.text.slice(0, 120));
  } else {
    console.log(`  ${CYAN}Note:${RESET} throwaway app ${appId} left published (pass --cleanup to delete)`);
  }

  return appId;
}

async function testGatewayIfRunning(appIdForGateway) {
  console.log(`\n${BOLD}--- Gateway (optional) ---${RESET}`);
  let health;
  try {
    health = await fetch(`${gateway}/health`);
  } catch {
    skip("gateway tests", "gateway not running — start with npm start");
    return;
  }
  if (!health.ok) {
    skip("gateway tests", `gateway health ${health.status}`);
    return;
  }
  check("gateway health", health.ok);

  const appId = appIdForGateway ?? randomUUID();
  const post = await fetch(`${gateway}/api/cloud/publish/${encodeURIComponent(appId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      loginAccess: "public",
      externalLink: "off",
      codeAccess: "off",
      requireSignIn: true,
      perUserIsolation: true,
      autoPublish: true,
    }),
  });
  const postText = await post.text();
  let postData;
  try {
    postData = JSON.parse(postText);
  } catch {
    postData = postText;
  }

  check("gateway POST publish → 200", post.status === 200, postText.slice(0, 240));
  if (post.status !== 200) return;

  check(
    "gateway prefs.requireSignIn=true",
    postData.prefs?.requireSignIn === true,
    JSON.stringify(postData.prefs),
  );
  check(
    "gateway prefs.perUserIsolation=true",
    postData.prefs?.perUserIsolation === true,
    JSON.stringify(postData.prefs),
  );

  const get = await fetch(`${gateway}/api/cloud/publish/${encodeURIComponent(appId)}`);
  const getData = await get.json();
  check("gateway GET → 200", get.status === 200);
  check(
    "gateway GET prefs.requireSignIn",
    getData.prefs?.requireSignIn === true,
    JSON.stringify(getData.prefs),
  );

  if (cleanup && post.status === 200) {
    await fetch(`${gateway}/api/cloud/publish/${encodeURIComponent(appId)}`, {
      method: "DELETE",
    });
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}requireSignIn E2E${RESET}`);
  console.log(`Memory:  ${memoryBase}`);
  console.log(`Gateway: ${gateway} (optional)`);
  console.log("=".repeat(70));

  if (!process.env.PAPR_API_KEY) {
    console.log(`${RED}PAPR_API_KEY missing — set in .env.local${RESET}`);
    process.exit(1);
  }

  try {
    const memHealth = await fetch(`${memoryBase}/health`);
    check("memory server reachable", memHealth.ok, `status=${memHealth.status}`);
  } catch (e) {
    console.log(`${RED}Memory not reachable at ${memoryBase}: ${e.message}${RESET}`);
    process.exit(1);
  }

  const appId = await testMemoryRequireSignIn();
  await testGatewayIfRunning(null);

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
  );

  if (failed > 0) {
    console.log(
      `\n${YELLOW}If requireSignIn checks failed, restart local memory server with latest code.${RESET}`,
    );
    process.exit(1);
  }
  console.log(`\n${GREEN}requireSignIn E2E passed${RESET}`);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
