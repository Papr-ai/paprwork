#!/usr/bin/env node
/**
 * E2E — runtime/repo-credentials + direct GitHub file fetch.
 *
 * Validates Phase 1 (direct GitHub) end-to-end against a memory server + optional
 * Cloud App Host. Uses the same runtime endpoint as repo-file (host key only —
 * no extra memory env beyond PAPR_CLOUD_APP_HOST_KEY already used for repo-file).
 *
 * Usage:
 *   node scripts/test-direct-github-e2e.mjs
 *   node scripts/test-direct-github-e2e.mjs --memory=http://127.0.0.1:5001
 *   node scripts/test-direct-github-e2e.mjs --namespace=85ZIB7mD1V --slug=joe-coffee-intelligence
 *   node scripts/test-direct-github-e2e.mjs --share-token=YOUR_TOKEN
 *   node scripts/test-direct-github-e2e.mjs --host=http://localhost:8787
 *
 * Env (.env.local): PAPR_CLOUD_APP_HOST_KEY (required)
 * Optional: PAPR_API_KEY (for apps that require sign-in, e.g. leadership-sync)
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
const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
const shareToken = arg("share-token") ?? process.env.PAPR_SHARE_TOKEN;
/** Prefer share-token for link apps; ignore ambient PAPR_API_KEY unless --api-key is set. */
const apiKey = arg("api-key") ?? (shareToken ? undefined : process.env.PAPR_API_KEY);

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
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
    ...(shareToken ? { shareToken } : {}),
    ...(apiKey ? { paprApiKey: apiKey } : {}),
    ...extra,
  });
}

function runtimeHeaders(includeHostKey = false) {
  return {
    "Content-Type": "application/json",
    ...(includeHostKey && hostKey ? { "X-Cloud-App-Host-Key": hostKey } : {}),
    ...(apiKey ? { "X-API-Key": apiKey } : {}),
  };
}

async function fetchGithubFile(creds, relativePath) {
  const prefix = creds.repoPath === "." ? "" : `${creds.repoPath.replace(/\/$/, "")}/`;
  const objectPath = `${prefix}${relativePath}`.replace(/^\//, "");
  const branch = creds.defaultBranch || "main";
  const url = `https://raw.githubusercontent.com/${creds.githubOrg}/${creds.repoName}/${branch}/${objectPath}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${creds.token}`,
      "User-Agent": "papr-direct-github-e2e",
    },
  });
  return { status: resp.status, text: resp.status === 200 ? await resp.text() : await resp.text() };
}

async function main() {
  console.log(`\nDirect GitHub E2E`);
  console.log(`Memory: ${memoryBase}`);
  console.log(`App: ${namespaceId}/${slug}`);
  if (shareToken) console.log(`Share token: yes`);
  if (apiKey) console.log(`API key: yes`);
  console.log("=".repeat(60));

  if (!hostKey) {
    console.log(`${RED}PAPR_CLOUD_APP_HOST_KEY required in .env.local${RESET}`);
    process.exit(1);
  }

  console.log("\n--- Memory: access/validate (ACL only) ---");
  const basic = await fetchJson(`${memoryBase}/v1/cloud/apps/access/validate`, {
    method: "POST",
    headers: runtimeHeaders(false),
    body: runtimeBody(),
  });
  check("access/validate → 200", basic.status === 200, `status=${basic.status} ${basic.text.slice(0, 120)}`);

  console.log("\n--- Memory: runtime/repo-credentials without host key → 401 ---");
  const noHost = await fetchJson(`${memoryBase}/v1/cloud/apps/runtime/repo-credentials`, {
    method: "POST",
    headers: runtimeHeaders(false),
    body: runtimeBody(),
  });
  check(
    "repo-credentials without host key rejected",
    noHost.status === 401,
    `status=${noHost.status}`,
  );

  console.log("\n--- Memory: runtime/repo-credentials + host key ---");
  const withCreds = await fetchJson(`${memoryBase}/v1/cloud/apps/runtime/repo-credentials`, {
    method: "POST",
    headers: runtimeHeaders(true),
    body: runtimeBody(),
  });
  check(
    "repo-credentials + host key → 200",
    withCreds.status === 200,
    `status=${withCreds.status} ${withCreds.text.slice(0, 160)}`,
  );

  const creds = withCreds.data;
  check(
    "credentials present",
    Boolean(creds?.token && creds?.githubOrg && creds?.repoName),
    JSON.stringify(creds ?? {}).slice(0, 120),
  );
  check("repoPath is string", typeof creds?.repoPath === "string", creds?.repoPath ?? "missing");

  if (creds?.token) {
    console.log("\n--- Direct GitHub fetch (same path Cloud App Host uses) ---");
    const t0 = performance.now();
    const gh = await fetchGithubFile(creds, "index.html");
    const ghMs = Math.round(performance.now() - t0);
    check(`GitHub index.html → 200 (${ghMs}ms)`, gh.status === 200, `status=${gh.status}`);
    check("index.html non-empty", (gh.text?.length ?? 0) > 50, `len=${gh.text?.length ?? 0}`);

    const t1 = performance.now();
    const [dist] = await Promise.all([fetchGithubFile(creds, "dist/app.js")]);
    const parallelMs = Math.round(performance.now() - t1);
    check(
      `parallel GitHub fetch dist/app.js (${parallelMs}ms)`,
      dist.status === 200,
      `dist=${dist.status}`,
    );
  }

  console.log("\n--- Cloud App Host ---");
  try {
    const health = await fetch(`${hostBase}/health`);
    if (!health.ok) {
      check("cloud app host running", false, `GET /health → ${health.status}`);
    } else {
      check("cloud app host /health", true, "");
      const pagePath = `/${namespaceId}/${slug}/`;
      const pageHeaders = { "Cache-Control": "max-age=0" };
      if (shareToken) {
        pageHeaders["X-Papr-Share-Token"] = shareToken;
      }
      const t0 = performance.now();
      const page = await fetch(`${hostBase}${pagePath}`, {
        headers: pageHeaders,
        redirect: "follow",
      });
      const pageMs = Math.round(performance.now() - t0);
      const html = await page.text();
      check(
        `GET ${pagePath} → ${page.status} (${pageMs}ms)`,
        page.status >= 200 && page.status < 400,
        `len=${html.length}`,
      );
      check("HTML contains papr or app shell", /papr|html|script/i.test(html), "");
    }
  } catch (err) {
    check("cloud app host reachable", false, err.message);
    console.log(`  ${YELLOW}Start: npm run start:cloud-app-host (PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001)${RESET}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${GREEN}${passed} passed${RESET}, ${failed ? RED + failed + " failed" + RESET : "0 failed"}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
