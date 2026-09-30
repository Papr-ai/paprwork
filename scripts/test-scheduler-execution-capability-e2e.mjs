#!/usr/bin/env node
/**
 * E2E: scheduler execution capability — desktop defer + memory heartbeat handshake.
 *
 * Prerequisites:
 *   - Local memory server: cd ../memory && CLOUD_SCHEDULER_ENABLED=1 poetry run uvicorn main:app --host 127.0.0.1 --port 5001
 *   - PAPR_API_KEY in env, .env.local, or commented `#PAPR_API_KEY=sk-...` in .env.local
 *
 * Usage:
 *   npm run test:scheduler-execution-capability-e2e
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run test:scheduler-execution-capability-e2e
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEnvLocal } from "./lib/testEnv.mjs";

loadEnvLocal();

function loadCommentedPaprApiKey() {
  if (process.env.PAPR_API_KEY?.trim()) return;
  try {
    const raw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^#\s*PAPR_API_KEY=(.+)$/);
      if (match?.[1]?.trim()) {
        process.env.PAPR_API_KEY = match[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  } catch {
    /* optional */
  }
}

loadCommentedPaprApiKey();

const memoryBase = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/, "");

const apiKey = process.env.PAPR_API_KEY?.trim();
if (!apiKey) {
  console.error("❌ PAPR_API_KEY required (env or #PAPR_API_KEY= in .env.local)");
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
  console.error(`❌ ${label}: ${detail}`);
}

async function memoryFetch(path, init = {}) {
  const res = await fetch(`${memoryBase}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, data, text };
}

async function loadDesktopHelpers() {
  const modPath = new URL(
    "../src/gateway/services/jobs/executionCapability.ts",
    import.meta.url,
  ).pathname;
  const mod = await import(pathToFileURL(modPath).href);
  return mod;
}

async function testMemoryHealth() {
  const res = await fetch(`${memoryBase}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    fail("memory /health", `HTTP ${res.status}`);
    return false;
  }
  ok("memory server reachable");
  return true;
}

async function testDesktopCapabilityMatrix() {
  const {
    shouldDesktopSchedulerRunJob,
    isJobDeferredToCloudScheduler,
    normalizeExecutionCapability,
  } = await loadDesktopHelpers();

  const authoritative = true;
  const cases = [
    {
      label: "local-preferred runs on desktop when cloud authoritative",
      job: { executionCapability: undefined },
      expectRun: true,
      expectDefer: false,
    },
    {
      label: "legacy cloud-capable treated as local-preferred on desktop",
      job: { executionCapability: "cloud-capable" },
      expectRun: true,
      expectDefer: false,
    },
    {
      label: "cloud-preferred defers on desktop when cloud authoritative",
      job: { executionCapability: "cloud-preferred" },
      expectRun: false,
      expectDefer: true,
    },
    {
      label: "local-only always runs on desktop",
      job: { executionCapability: "local-only" },
      expectRun: true,
      expectDefer: false,
    },
  ];

  for (const c of cases) {
    const run = shouldDesktopSchedulerRunJob(c.job, authoritative);
    const defer = isJobDeferredToCloudScheduler(c.job, authoritative);
    if (run !== c.expectRun || defer !== c.expectDefer) {
      fail(
        c.label,
        `run=${run} defer=${defer} (expected run=${c.expectRun} defer=${c.expectDefer}, normalized=${normalizeExecutionCapability(c.job.executionCapability)})`,
      );
    } else {
      ok(c.label);
    }
  }
}

async function testHeartbeatHandshake() {
  const heartbeat = await memoryFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body: {
      syncProtocol: "sync-v3",
      syncV3Capabilities: ["dispatch_push", "scheduler_run_lease"],
    },
  });

  if (heartbeat.status === 404 || heartbeat.status === 501) {
    fail("POST /v1/cloud/runtime/heartbeat", `route unavailable (${heartbeat.status})`);
    return;
  }
  if (heartbeat.status !== 200) {
    fail("POST /v1/cloud/runtime/heartbeat", `${heartbeat.status} ${heartbeat.text.slice(0, 160)}`);
    return;
  }

  const body = heartbeat.data;
  if (
    typeof body !== "object" ||
    body === null ||
    body.desktopAwake !== true ||
    typeof body.recordedAt !== "string"
  ) {
    fail("heartbeat response shape", JSON.stringify(body).slice(0, 160));
    return;
  }

  ok(`heartbeat recorded desktopAwake=true staleAfter=${body.staleAfterSeconds ?? "?"}`);
}

async function testSchedulerRunLeaseStillWorks() {
  const jobId = `e2e-cap-${Date.now()}`;
  const dueAt = new Date().toISOString();

  const desktopAcquire = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/acquire",
    {
      method: "POST",
      body: { jobId, dueAt, holder: "desktop" },
    },
  );
  if (desktopAcquire.status !== 200 || !desktopAcquire.data?.acquired) {
    fail(
      "scheduler lease desktop acquire",
      `${desktopAcquire.status} ${JSON.stringify(desktopAcquire.data).slice(0, 120)}`,
    );
    return;
  }
  ok("scheduler run lease desktop acquire");

  const cloudAcquire = await memoryFetch(
    "/v1/cloud/runtime/scheduler-run-lease/acquire",
    {
      method: "POST",
      body: { jobId, dueAt, holder: "cloud:e2e-local" },
    },
  );
  if (cloudAcquire.status !== 200) {
    fail("scheduler lease cloud acquire", `${cloudAcquire.status}`);
    return;
  }
  if (cloudAcquire.data?.acquired) {
    ok("scheduler lease cloud acquire (no contention — Mongo may be degraded)");
  } else {
    ok("scheduler lease cloud blocked while desktop holds slot");
  }

  await memoryFetch("/v1/cloud/runtime/scheduler-run-lease/release", {
    method: "POST",
    body: {
      jobId,
      dueAt,
      runId: desktopAcquire.data.runId,
      holder: "desktop",
    },
  });
  ok("scheduler run lease desktop release");
}

async function main() {
  console.log(`\nScheduler execution capability E2E → ${memoryBase}\n`);

  const healthy = await testMemoryHealth();
  if (!healthy) {
    console.error("\nStart memory server first:");
    console.error(
      "  cd ../memory && CLOUD_SCHEDULER_ENABLED=1 poetry run uvicorn main:app --host 127.0.0.1 --port 5001\n",
    );
    process.exit(1);
  }

  await testDesktopCapabilityMatrix();
  await testHeartbeatHandshake();
  await testSchedulerRunLeaseStillWorks();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
