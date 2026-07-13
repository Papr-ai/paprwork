#!/usr/bin/env node
/**
 * Mini-app backend + bash policy E2E (local gateway or Cloud App Host).
 *
 * Usage:
 *   node scripts/test-cloud-app-backend-e2e.mjs [--host URL] [--app-id ID]
 *
 * Aliases: --gateway= (same as --host=)
 *
 * Defaults:
 *   host: http://localhost:18789
 *
 * Cloud (apps.papr.ai):
 *   - Requires PAPR_API_KEY in .env.local or env
 *   - Fetches publish config from memory for namespace/slug headers
 *   - Unauthenticated calls expect 401/403 (route protected)
 *
 * Local gateway:
 *   - No auth headers; runs handler from ~/Papr/apps/{appId}/backend/
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const hostArg =
  args.find((a) => a.startsWith("--host="))?.split("=").slice(1).join("=") ??
  args.find((a) => a.startsWith("--gateway="))?.split("=").slice(1).join("=");
const baseUrl = (hostArg ?? "http://localhost:18789").replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

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

function isCloudHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

function pickAppIdWithBackend() {
  if (appIdArg) return appIdArg;
  const appsRoot = join(homedir(), "Papr", "apps");
  try {
    for (const dir of readdirSync(appsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifest = join(appsRoot, dir.name, "backend", "manifest.json");
      if (existsSync(manifest)) return dir.name;
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return list.find((a) => a?.id)?.id ?? null;
  } catch {
    return null;
  }
}

function readLocalBackendAction(appId) {
  const manifestPath = join(homedir(), "Papr", "apps", appId, "backend", "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actionName = Object.keys(manifest.actions ?? {})[0];
  if (!actionName) return null;
  return { actionName, manifestPath };
}

async function fetchPublishContext(appId, apiKey) {
  const memoryBase =
    process.env.PAPR_MEMORY_SERVER_URL ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai";

  const res = await fetch(
    `${memoryBase}/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
    { headers: { "X-API-Key": apiKey } },
  );
  if (!res.ok) {
    throw new Error(`publish config ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const cfg = await res.json();
  const parts = String(cfg.shareUrl ?? "").split("/").filter(Boolean);
  const slug = cfg.slug ?? parts[parts.length - 1];
  const namespaceId = parts[parts.length - 2];
  if (!namespaceId || !slug) {
    throw new Error(`invalid shareUrl: ${cfg.shareUrl}`);
  }
  return { namespaceId, slug, visibility: cfg.visibility };
}

function cloudAuthHeaders(publishCtx, apiKey) {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Papr-Namespace-Id": publishCtx.namespaceId,
    "X-Papr-Slug": publishCtx.slug,
    "Cache-Control": "no-cache",
  };
}

async function main() {
  loadEnvLocal();
  const cloud = isCloudHost(baseUrl);

  console.log(`\nMini-app backend E2E (${baseUrl})`);
  console.log(`Mode: ${cloud ? "cloud" : "local"}\n`);

  try {
    const health = await fetch(`${baseUrl}/health`);
    const healthJson = await health.json().catch(() => ({}));
    check("Host health", health.ok, `status ${health.status}`);
    if (cloud) {
      check("service is cloud-app-host", healthJson.service === "cloud-app-host", JSON.stringify(healthJson));
    }
  } catch (err) {
    check("Host reachable", false, String(err));
    process.exit(1);
  }

  const bashRes = await fetch(`${baseUrl}/api/bash/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo hi" }),
  });
  const bashBody = await bashRes.json().catch(() => ({}));
  check(
    "POST /api/bash/run returns 403 for mini-apps",
    bashRes.status === 403 && bashBody.error === "mini_app_bash_disabled",
    `status=${bashRes.status}`,
  );

  const unauthRes = await fetch(`${baseUrl}/api/app/backend/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "00000000-0000-0000-0000-000000000000" }),
  });
  const unauthOk = cloud
    ? unauthRes.status === 401 || unauthRes.status === 403
    : unauthRes.status === 400 ||
      unauthRes.status === 404 ||
      unauthRes.status === 500;
  check(
    cloud
      ? "POST /api/app/backend/:action requires auth (401/403)"
      : "POST /api/app/backend/:action route exists",
    unauthOk,
    `status=${unauthRes.status}`,
  );

  const appId = pickAppIdWithBackend();
  if (!appId) {
    skip("backend action execution", "pass --app-id=UUID or add backend/manifest.json under ~/Papr/apps/");
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const backend = readLocalBackendAction(appId);
  if (!backend) {
    skip(
      "backend action execution",
      `no backend/manifest.json at ~/Papr/apps/${appId}/backend/`,
    );
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log(`  App: ${appId}, action: ${backend.actionName}`);

  let headers = { "Content-Type": "application/json" };
  if (cloud) {
    const apiKey = process.env.PAPR_API_KEY;
    if (!apiKey) {
      skip("backend action execution", "PAPR_API_KEY required for cloud host");
      console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
      process.exit(failed > 0 ? 1 : 0);
    }
    try {
      const publishCtx = await fetchPublishContext(appId, apiKey);
      console.log(`  Publish: ${publishCtx.namespaceId}/${publishCtx.slug} (${publishCtx.visibility})`);
      headers = cloudAuthHeaders(publishCtx, apiKey);
    } catch (err) {
      check("fetch publish config from memory", false, err instanceof Error ? err.message : String(err));
      console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
      process.exit(1);
    }
  }

  const actionRes = await fetch(`${baseUrl}/api/app/backend/${backend.actionName}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ appId, params: { e2e: "true" } }),
  });
  const actionBody = await actionRes.json().catch(() => ({}));
  check(
    `POST /api/app/backend/${backend.actionName} → 200`,
    actionRes.status === 200,
    `status=${actionRes.status} body=${JSON.stringify(actionBody).slice(0, 200)}`,
  );
  if (actionRes.status === 200) {
    check(
      "handler exitCode === 0",
      actionBody.exitCode === 0,
      `exit=${actionBody.exitCode} stderr=${String(actionBody.stderr).slice(0, 120)}`,
    );
    check(
      "stdout contains handler JSON",
      typeof actionBody.stdout === "string" && actionBody.stdout.includes('"ok"'),
      actionBody.stdout?.slice(0, 120),
    );
  }

  if (cloud && headers["X-Papr-Namespace-Id"] && headers["X-Papr-Slug"]) {
    const staticRes = await fetch(
      `${baseUrl}/${headers["X-Papr-Namespace-Id"]}/${headers["X-Papr-Slug"]}/backend/manifest.json`,
    );
    check(
      "backend/ not served as static file (404)",
      staticRes.status === 404,
      `status=${staticRes.status}`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
