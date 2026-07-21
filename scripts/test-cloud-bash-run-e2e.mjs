#!/usr/bin/env node
/**
 * E2E: cloud one-shot bash — memory bash-run + Cloud App Host /api/bash/run
 *
 * Usage:
 *   node scripts/test-cloud-bash-run-e2e.mjs [--memory URL] [--host URL] [--namespace NS] [--slug SLUG]
 *
 * If --namespace/--slug omitted, publishes a ephemeral team app via memory API.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "https://memory.papr.ai"
).replace(/\/$/, "");
const host = (
  args.find((a) => a.startsWith("--host="))?.split("=")[1] ??
  "http://localhost:8787"
).replace(/\/$/, "");
const namespaceArg = args.find((a) => a.startsWith("--namespace="))?.split("=")[1];
const slugArg = args.find((a) => a.startsWith("--slug="))?.split("=")[1];

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

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
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return list.find((a) => a?.id)?.id ?? null;
  } catch {
    return null;
  }
}

async function memoryFetch(path, { method = "GET", body = null, headers = {} } = {}) {
  const key = process.env.PAPR_API_KEY;
  if (!key) throw new Error("PAPR_API_KEY required");

  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      ...headers,
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

async function resolvePublishContext() {
  if (namespaceArg && slugArg) {
    return { namespaceId: namespaceArg, slug: slugArg };
  }
  const appId = pickAppId();
  if (!appId) throw new Error("No app id — pass --namespace= and --slug= or add apps.json");
  const slug = `bash-e2e-${Date.now().toString(36)}`;
  const res = await memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: { appId, slug, visibility: "team", linkPermission: "read" },
  });
  if (res.status !== 200) {
    throw new Error(`publish failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const parts = res.data.shareUrl?.split("/") ?? [];
  const namespaceId = parts[parts.length - 2];
  return { appId, slug, namespaceId, shareUrl: res.data.shareUrl };
}

async function testMemoryBashRun(ctx) {
  console.log(`\n${BOLD}--- Memory POST /v1/cloud/apps/runtime/bash-run ---${RESET}`);
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
  if (!hostKey) {
    check("PAPR_CLOUD_APP_HOST_KEY set", false);
    return;
  }
  check("PAPR_CLOUD_APP_HOST_KEY set", true);

  const res = await memoryFetch("/v1/cloud/apps/runtime/bash-run", {
    method: "POST",
    headers: { "X-Cloud-App-Host-Key": hostKey },
    body: {
      namespaceId: ctx.namespaceId,
      slug: ctx.slug,
      command: "echo cloud-bash-ok",
      timeoutMs: 15000,
    },
  });

  if (res.status === 404) {
    check(
      "bash-run endpoint exists",
      false,
      "404 — redeploy memory server with bash-run route",
    );
    return;
  }

  check("bash-run → 200", res.status === 200, res.text.slice(0, 300));
  if (res.status === 200) {
    check("exitCode 0", res.data.exitCode === 0, JSON.stringify(res.data));
    check(
      "stdout contains marker",
      String(res.data.stdout).includes("cloud-bash-ok"),
      res.data.stdout,
    );
  }
}

async function testHostBashRun(ctx) {
  console.log(`\n${BOLD}--- Cloud App Host POST /api/bash/run ---${RESET}`);
  try {
    const health = await fetch(`${host}/health`);
    if (!health.ok) {
      check("host running", false, `health ${health.status}`);
      return;
    }
  } catch (e) {
    check("host running", false, `${e.message} — npm run start:cloud-app-host`);
    return;
  }
  check("host running", true);

  const res = await fetch(`${host}/api/bash/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Papr-Namespace-Id": ctx.namespaceId,
      "X-Papr-Slug": ctx.slug,
      ...(process.env.PAPR_API_KEY ? { "X-API-Key": process.env.PAPR_API_KEY } : {}),
    },
    body: JSON.stringify({
      command: "echo host-bash-ok",
      timeoutMs: 15000,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  check("POST /api/bash/run → 200", res.status === 200, text.slice(0, 300));
  if (res.status === 200) {
    check("exitCode 0", data.exitCode === 0, JSON.stringify(data));
    check(
      "stdout contains marker",
      String(data.stdout).includes("host-bash-ok"),
      data.stdout,
    );
  }
}

async function main() {
  loadEnvLocal();
  console.log(`\n${BOLD}Cloud Bash Run E2E${RESET}`);
  console.log(`Memory: ${memoryBase}`);
  console.log(`Host:   ${host}`);
  console.log("=".repeat(60));

  if (!process.env.PAPR_API_KEY) {
    console.log(`${RED}PAPR_API_KEY missing (set in .env.local)${RESET}`);
    process.exit(1);
  }

  const ctx = await resolvePublishContext();
  console.log(`Context: ${ctx.namespaceId}/${ctx.slug}`);

  await testMemoryBashRun(ctx);
  await testHostBashRun(ctx);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e.message);
  process.exit(1);
});
