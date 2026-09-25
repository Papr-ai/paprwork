#!/usr/bin/env node
/**
 * E2E smoke: memory server shared-delete routes + paprwork delete-scope unit tests.
 *
 * Full Mongo + auth policy E2E lives in memory repo:
 *   cd ../memory && poetry run python tests/test_cloud_shared_delete_e2e.py
 *
 * Usage:
 *   PAPR_API_KEY=sk-... PAPR_MEMORY_SERVER_URL=http://127.0.0.1:8000 \
 *     node scripts/test-shared-delete-guard-e2e.mjs
 *
 *   node scripts/test-shared-delete-guard-e2e.mjs --with-vitest
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const withVitest = args.includes("--with-vitest");
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://127.0.0.1:8000"
).replace(/\/$/, "");

function loadApiKey() {
  if (process.env.PAPR_API_KEY) return process.env.PAPR_API_KEY;
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), "Papr", "data", "settings.json"), "utf8"),
    );
    return settings?.customKeys?.PAPR_API_KEY ?? null;
  } catch {
    return null;
  }
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("❌ PAPR_API_KEY or settings customKeys.PAPR_API_KEY required");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`✅ ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`❌ ${label}${detail ? `: ${detail}` : ""}`);
}

async function memorySmoke() {
  const health = await fetch(`${memoryBase}/health`);
  if (!health.ok) {
    fail(`Memory server health (${memoryBase})`, String(health.status));
    return;
  }
  ok(`Memory server up (${memoryBase})`);

  const fakeDb = `d-e2e${Math.random().toString(16).slice(2, 8)}`;
  const delDb = await fetch(`${memoryBase}/v1/cloud/databases/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "X-Client-Type": "papr_plugin",
    },
    body: JSON.stringify({ database: fakeDb }),
  });
  if ([200, 403, 400, 404].includes(delDb.status)) {
    ok(`POST /v1/cloud/databases/delete (${delDb.status})`);
  } else {
    fail("POST /v1/cloud/databases/delete", `${delDb.status} ${await delDb.text()}`);
  }

  const jobId = `e2e-live-${Math.random().toString(16).slice(2, 10)}`;
  const delJob = await fetch(
    `${memoryBase}/v1/cloud/runtime/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "DELETE",
      headers: {
        "X-API-Key": apiKey,
        "X-Client-Type": "papr_plugin",
      },
    },
  );
  if ([200, 403, 400].includes(delJob.status)) {
    ok(`DELETE /v1/cloud/runtime/jobs/{id} (${delJob.status})`);
  } else {
    fail("DELETE /v1/cloud/runtime/jobs/{id}", `${delJob.status} ${await delJob.text()}`);
  }
}

function runVitest() {
  const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) {
    fail("vitest", "node_modules not installed");
    return;
  }
  const r = spawnSync(
    process.execPath,
    [vitest, "run", "tests/app-delete-scope.test.ts", "--project", "unit-backend"],
    { stdio: "inherit", env: process.env },
  );
  if (r.status === 0) {
    ok("paprwork app-delete-scope vitest");
  } else {
    fail("paprwork app-delete-scope vitest", `exit ${r.status}`);
  }
}

console.log("--- Memory live smoke ---");
await memorySmoke();

if (withVitest) {
  console.log("\n--- Paprwork delete scope ---");
  runVitest();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

console.log(
  "\nFor full policy E2E (Mongo lineage + 403 assertions), run in memory repo:\n" +
    "  poetry run python tests/test_cloud_shared_delete_e2e.py",
);
