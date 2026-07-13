#!/usr/bin/env node
/**
 * Cloud publish permissions E2E — switch accessMode via gateway and verify memory persistence.
 *
 * Mirrors Settings → Cloud Sync → Sharing dropdown flow.
 *
 * Prerequisites:
 *   1. Paprwork running (gateway on http://localhost:18789)
 *   2. Logged in with Papr (gateway uses keychain key for cloud API)
 *
 * Persistence is verified via gateway GET (same auth as Settings UI).
 * Direct memory GET is optional diagnostics only when PAPR_API_KEY matches.
 *   node scripts/test-cloud-publish-permissions-e2e.mjs [--gateway URL] [--app-id ID] [--restore MODE]
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const restoreMode =
  args.find((a) => a.startsWith("--restore="))?.split("=")[1] ?? "team";

const MODES = ["private", "team", "link_read", "link_read_write"];

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
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

function memoryBaseUrl() {
  return (
    process.env.PAPR_MEMORY_SERVER_URL ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai"
  );
}

async function gatewayPublish(appId, accessMode) {
  const url = `${gateway}/api/cloud/publish/${encodeURIComponent(appId)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessMode, autoPublish: true }),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function gatewayGet(appId) {
  const url = `${gateway}/api/cloud/publish/${encodeURIComponent(appId)}`;
  const resp = await fetch(url);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function memoryGet(appId) {
  const key = process.env.PAPR_API_KEY;
  if (!key) throw new Error("PAPR_API_KEY not set in .env.local");
  const url = `${memoryBaseUrl()}/v1/cloud/apps/publish/${encodeURIComponent(appId)}`;
  const resp = await fetch(url, {
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

function linkModeNeedsToken(mode) {
  return mode === "link_read" || mode === "link_read_write";
}

async function testMode(appId, accessMode) {
  console.log(`\n${BOLD}--- Switch to ${CYAN}${accessMode}${RESET}${BOLD} ---${RESET}`);

  const post = await gatewayPublish(appId, accessMode);
  check(`POST gateway publish → 200 (${accessMode})`, post.status === 200, post.text.slice(0, 240));
  if (post.status !== 200) return;

  check(
    `gateway response accessMode=${accessMode}`,
    post.data.accessMode === accessMode,
    JSON.stringify({ accessMode: post.data.accessMode }),
  );
  check("gateway enabled=true", post.data.enabled === true, JSON.stringify(post.data.enabled));
  check("gateway shareUrl present", !!post.data.shareUrl, post.data.shareUrl ?? "missing");

  if (linkModeNeedsToken(accessMode)) {
    check(
      "gateway POST shareUrl has ?t= token",
      typeof post.data.shareUrl === "string" && post.data.shareUrl.includes("?t="),
      post.data.shareUrl,
    );
    check(
      "gateway POST shareToken present",
      !!post.data.shareToken,
      post.data.shareToken ? "(set)" : "missing",
    );
  } else {
    check(
      "gateway shareUrl has no ?t= (login modes)",
      !post.data.shareUrl?.includes("?t="),
      post.data.shareUrl,
    );
  }

  // Poll gateway GET — same auth path as Settings UI
  let gwGet = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 600));
    gwGet = await gatewayGet(appId);
    if (gwGet.status === 200 && gwGet.data.accessMode === accessMode) break;
  }

  check(`gateway GET → 200 (${accessMode})`, gwGet?.status === 200, gwGet?.text.slice(0, 240));
  if (gwGet?.status === 200) {
    check(
      `gateway GET persisted accessMode=${accessMode}`,
      gwGet.data.accessMode === accessMode,
      JSON.stringify({ accessMode: gwGet.data.accessMode }),
    );
    check(
      "gateway GET enabled=true",
      gwGet.data.enabled === true,
      JSON.stringify(gwGet.data.enabled),
    );
  }

  // Optional: direct memory check (may differ if .env.local key ≠ keychain key)
  if (process.env.PAPR_API_KEY && process.env.CHECK_MEMORY_DIRECT === "1") {
    const mem = await memoryGet(appId);
    check(`memory GET → 200 (${accessMode})`, mem.status === 200, mem.text.slice(0, 240));
    if (mem.status === 200) {
      check(
        `memory visibility=${accessMode}`,
        mem.data.visibility === accessMode,
        JSON.stringify({ visibility: mem.data.visibility }),
      );
    }
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}Cloud Publish Permissions E2E${RESET}`);
  console.log(`Gateway: ${gateway}`);
  console.log(`Memory:  ${memoryBaseUrl()}`);
  console.log("=".repeat(70));

  try {
    const health = await fetch(`${gateway}/health`);
    check("gateway health", health.ok, `status=${health.status}`);
  } catch (e) {
    console.log(`\n${RED}Gateway not running — start with npm start${RESET}`);
    process.exit(1);
  }

  if (!process.env.PAPR_API_KEY) {
    console.log(`${YELLOW}Note: PAPR_API_KEY not in .env.local — skipping direct memory checks${RESET}`);
  }

  const appId = pickAppId();
  if (!appId) {
    console.log(`\n${RED}No app ID — pass --app-id=...${RESET}`);
    process.exit(1);
  }
  console.log(`App ID: ${appId}`);

  const initial = await gatewayGet(appId);
  console.log(`Initial accessMode: ${initial.data?.accessMode ?? "unknown"}`);

  for (const mode of MODES) {
    await testMode(appId, mode);
  }

  if (restoreMode && restoreMode !== MODES[MODES.length - 1]) {
    console.log(`\n${BOLD}--- Restore to ${CYAN}${restoreMode}${RESET}${BOLD} ---${RESET}`);
    await gatewayPublish(appId, restoreMode);
    const restored = await gatewayGet(appId);
    check(
      `restored gateway accessMode=${restoreMode}`,
      restored.data?.accessMode === restoreMode,
      JSON.stringify({ accessMode: restored.data?.accessMode }),
    );
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET} / ${passed + failed}`,
  );

  if (failed > 0) process.exit(1);
  console.log(`\n${GREEN}All permission switches persisted in cloud!${RESET}`);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
