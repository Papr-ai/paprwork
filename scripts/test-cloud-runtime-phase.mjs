#!/usr/bin/env node
/**
 * E2E smoke tests for Phase 3C/3D/4A cloud runtime.
 *
 * Requires PAPR_API_KEY (or ~/.paprwork keychain via gateway env).
 *
 *   node scripts/test-cloud-runtime-phase.mjs
 *   PAPR_MEMORY_SERVER_URL=https://memory.papr.ai node scripts/test-cloud-runtime-phase.mjs
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE =
  process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ??
  "https://memory.papr.ai";

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
  console.error("❌ PAPR_API_KEY required");
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

async function testHeartbeat() {
  const res = await fetch(`${BASE}/v1/cloud/runtime/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: "{}",
  });
  if (!res.ok) {
    fail("heartbeat", `${res.status} ${(await res.text()).slice(0, 120)}`);
    return;
  }
  const body = await res.json();
  if (!body.recordedAt || typeof body.staleAfterSeconds !== "number") {
    fail("heartbeat shape", JSON.stringify(body).slice(0, 120));
    return;
  }
  if (!Array.isArray(body.pendingCloudRuns)) {
    fail("heartbeat pendingCloudRuns", "missing array");
    return;
  }
  ok(`heartbeat (cloudRuns=${body.pendingCloudRuns.length})`);
}

async function testHeartbeatSyncV3Handshake() {
  const res = await fetch(`${BASE}/v1/cloud/runtime/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      syncProtocol: "v3",
      appVersion: "2.0.0-e2e",
      syncV3Capabilities: ["SYNC_V3_PER_APP_REPOS"],
    }),
  });
  if (!res.ok) {
    fail("heartbeat v3 handshake", `${res.status} ${(await res.text()).slice(0, 120)}`);
    return;
  }
  const body = await res.json();
  if (!body.recordedAt) {
    fail("heartbeat v3 shape", JSON.stringify(body).slice(0, 120));
    return;
  }
  ok("heartbeat v3 Sync V3 handshake");
}

async function testSessionsStreamCursor() {
  const res = await fetch(`${BASE}/v1/cloud/runtime/sessions/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      chatId: `e2e-${Date.now()}`,
      prompt: 'Reply with exactly: CLOUD_RUNTIME_OK',
      provider: "cursor",
      model: "composer-2.5",
      tier: "sandbox",
      runtime: "cloud",
    }),
  });

  if (res.status === 501 || res.status === 503) {
    fail("sessions/stream cursor", `${res.status} ${(await res.text()).slice(0, 120)}`);
    return;
  }
  if (!res.ok) {
    fail("sessions/stream cursor", `${res.status} ${(await res.text()).slice(0, 120)}`);
    return;
  }

  const text = await res.text();
  if (!text.includes("session-meta") && !text.includes("text-delta")) {
    fail("sessions/stream cursor SSE", text.slice(0, 200));
    return;
  }
  ok("sessions/stream cursor SSE");
}

async function testSessionsStreamAnthropic() {
  const res = await fetch(`${BASE}/v1/cloud/runtime/sessions/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      chatId: `e2e-anthropic-${Date.now()}`,
      prompt: 'Say exactly: ANTHROPIC_CLOUD_OK',
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tier: "sandbox",
    }),
  });

  if (res.status === 501) {
    fail("sessions/stream anthropic", "still 501 — deploy memory with multi-provider support");
    return;
  }
  if (!res.ok) {
    fail("sessions/stream anthropic", `${res.status} ${(await res.text()).slice(0, 120)}`);
    return;
  }

  const text = await res.text();
  if (!text.includes("done")) {
    fail("sessions/stream anthropic SSE", text.slice(0, 200));
    return;
  }
  ok("sessions/stream anthropic SSE");
}

async function testListJobs() {
  const res = await fetch(`${BASE}/v1/cloud/runtime/jobs`, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) {
    fail("GET /jobs", `${res.status}`);
    return;
  }
  const body = await res.json();
  if (!Array.isArray(body.jobs)) {
    fail("GET /jobs shape", JSON.stringify(body).slice(0, 80));
    return;
  }
  ok(`GET /jobs (${body.count ?? body.jobs.length} jobs)`);
}

console.log(`\nCloud runtime phase tests → ${BASE}\n`);

await testHeartbeat();
await testHeartbeatSyncV3Handshake();
await testListJobs();
await testSessionsStreamAnthropic();
await testSessionsStreamCursor();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
