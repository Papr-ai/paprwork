#!/usr/bin/env node
/**
 * Catalog automation E2E — build from jobs → memory publish → community list
 *
 * Prerequisites:
 *   1. Local memory server with catalogAutomation support:
 *        cd ../memory && .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 5001
 *   2. Paprwork gateway restarted after setting PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001
 *   3. Papr login (gateway uses keychain for /api/cloud proxy)
 *
 * Usage:
 *   node scripts/test-catalog-automation-e2e.mjs
 *   node scripts/test-catalog-automation-e2e.mjs --app-id=6b0a8fa3-3a04-4b8b-a0b3-5d86f52b093f --sync
 *   node scripts/test-catalog-automation-e2e.mjs --gateway=http://localhost:18789
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  fallback;

const gatewayBase = arg("gateway", "http://localhost:18789").replace(/\/$/, "");
const memoryBase = arg(
  "memory",
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001",
).replace(/\/$/, "");
const appId =
  arg("app-id", "6b0a8fa3-3a04-4b8b-a0b3-5d86f52b093f") ??
  "6b0a8fa3-3a04-4b8b-a0b3-5d86f52b093f";
const doSync = args.includes("--sync");

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

async function gatewayFetch(method, path, body) {
  const resp = await fetch(`${gatewayBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
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

function readActivePaprHome() {
  const pointerPath = join(process.env.HOME ?? "", "Papr", ".active-workspace.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  if (!pointer?.paprHome) {
    throw new Error(`Missing paprHome in ${pointerPath}`);
  }
  return pointer.paprHome;
}

async function loadBuildCatalogAutomation() {
  const distPath = join(process.cwd(), "dist/core/utils/catalogAutomation.js");
  const srcPath = join(process.cwd(), "src/core/utils/catalogAutomation.ts");
  try {
    const mod = await import(pathToFileURL(distPath).href);
    return mod.buildCatalogAutomationForApp;
  } catch {
    const mod = await import(pathToFileURL(srcPath).href);
    return mod.buildCatalogAutomationForApp;
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}Catalog automation E2E${RESET}`);
  console.log(`Gateway: ${gatewayBase}`);
  console.log(`Memory:  ${memoryBase}`);
  console.log(`App:     ${appId}`);
  console.log("=".repeat(60));

  console.log(`\n${BOLD}--- Health ---${RESET}`);
  try {
    const mem = await fetch(`${memoryBase}/health`, { signal: AbortSignal.timeout(5_000) });
    check("local memory /health → 200", mem.status === 200, `status=${mem.status}`);
  } catch (e) {
    check("local memory reachable", false, e.message);
  }

  try {
    const gw = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(5_000) });
    check("gateway /health → 200", gw.status === 200, `status=${gw.status}`);
  } catch (e) {
    check("gateway reachable", false, e.message);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Build from linked jobs ---${RESET}`);
  let expectedAutomation = null;
  try {
    const paprHome = readActivePaprHome();
    const jobsRaw = readFileSync(join(paprHome, "data/jobs.json"), "utf8");
    const jobs = JSON.parse(jobsRaw);
    const list = Array.isArray(jobs) ? jobs : Object.values(jobs);
    const buildCatalogAutomationForApp = await loadBuildCatalogAutomation();
    expectedAutomation = buildCatalogAutomationForApp(appId, list);
    check("expected catalogAutomation built", expectedAutomation !== null, "no scheduled jobs linked");
    if (expectedAutomation) {
      check("cardLine present", typeof expectedAutomation.cardLine === "string");
      console.log(`  ${CYAN}cardLine:${RESET} ${expectedAutomation.cardLine}`);
    }
  } catch (e) {
    check("build catalogAutomation from jobs", false, e.message);
  }

  console.log(`\n${BOLD}--- Memory publish record (via gateway proxy) ---${RESET}`);
  const before = await gatewayFetch(
    "GET",
    `/api/cloud/apps/publish/${encodeURIComponent(appId)}`,
  );
  check("GET apps/publish → 200", before.status === 200, before.text.slice(0, 180));
  const published = before.status === 200 ? before.data : null;
  if (published) {
    console.log(`  slug=${published.slug} visibility=${published.visibility}`);
    if (published.catalogAutomation) {
      check(
        "catalogAutomation already on publish record",
        published.catalogAutomation.cardLine === expectedAutomation?.cardLine,
        JSON.stringify(published.catalogAutomation),
      );
    } else {
      console.log(`  ${YELLOW}catalogAutomation not set yet (expected before first catalog sync)${RESET}`);
    }
  }

  if (!doSync) {
    skip(
      "catalog sync write",
      "pass --sync after restarting npm start with PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001",
    );
  } else if (!expectedAutomation || !published) {
    skip("catalog sync write", "missing expected automation or publish record");
  } else {
    console.log(`\n${BOLD}--- Catalog sync (intent:catalog) ---${RESET}`);
    const postBody = {
      appId,
      slug: published.slug,
      visibility: published.visibility,
      linkPermission: published.linkPermission,
      codeAccess: published.codeAccess ?? "off",
      intent: "catalog",
      catalogAutomation: expectedAutomation,
    };
    const post = await gatewayFetch("POST", "/api/cloud/apps/publish", postBody);
    check("POST apps/publish intent:catalog → 200", post.status === 200, post.text.slice(0, 200));

    const after = await gatewayFetch(
      "GET",
      `/api/cloud/apps/publish/${encodeURIComponent(appId)}`,
    );
    check("GET after sync → 200", after.status === 200, after.text.slice(0, 120));
    check(
      "catalogAutomation persisted",
      after.data?.catalogAutomation?.cardLine === expectedAutomation.cardLine,
      JSON.stringify(after.data?.catalogAutomation),
    );

    const community = await gatewayFetch("GET", "/api/cloud/apps/community");
    check("GET apps/community → 200", community.status === 200, community.text.slice(0, 120));
    const entry = community.data?.apps?.find((a) => a.appId === appId);
    if (entry) {
      check(
        "community entry includes catalogAutomation",
        entry.catalogAutomation?.cardLine === expectedAutomation.cardLine,
        JSON.stringify(entry.catalogAutomation),
      );
    } else {
      skip(
        "community entry check",
        "app not in global community list (needs public_read + codeAccess=install)",
      );
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
  );
  if (!doSync && failed === 0) {
    console.log(
      `\n${CYAN}Next:${RESET} restart \`npm start\` (gateway must reload PAPR_MEMORY_SERVER_URL), then re-run with --sync`,
    );
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
