#!/usr/bin/env node
/**
 * E2E: App-agent warm + stream — Memory runtime + optional Cloud App Host
 *
 * Exercises:
 *   POST /v1/cloud/apps/runtime/app-agent/warm
 *   POST /v1/cloud/apps/runtime/app-agent/stream  (SSE)
 *   POST /api/app-agent/sessions + warm + message + stream  (when --host is reachable)
 *
 * Prerequisites (.env.local or env):
 *   PAPR_API_KEY
 *   PAPR_CLOUD_APP_HOST_KEY
 *   ANTHROPIC_API_KEY (for live stream turns against real gateway)
 *
 * Published app must have enable_app_agent_chat + republish (metadata.json agentChatJobId).
 *
 * Usage:
 *   node scripts/test-app-agent-warm-e2e.mjs \
 *     --namespace=YOUR_NS --slug=YOUR_SLUG --app-id=YOUR_APP_ID
 *
 *   node scripts/test-app-agent-warm-e2e.mjs --memory-only --warm-only
 *   node scripts/test-app-agent-warm-e2e.mjs --host=https://apps.papr.ai
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

const gatewayBase = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  process.env.CLOUD_AGENT_GATEWAY_URL ??
  ""
).replace(/\/$/, "");

const namespaceArg = args.find((a) => a.startsWith("--namespace="))?.split("=")[1];
const slugArg = args.find((a) => a.startsWith("--slug="))?.split("=")[1];
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const jobIdArg = args.find((a) => a.startsWith("--job-id="))?.split("=")[1];
const subAgentIdArg = args.find((a) => a.startsWith("--sub-agent-id="))?.split("=")[1];
const sessionIdArg = args.find((a) => a.startsWith("--session-id="))?.split("=")[1];

const memoryOnly = args.includes("--memory-only");
const warmOnly = args.includes("--warm-only");
const skipGateway = args.includes("--skip-gateway");

const E2E_MARKER = "APP_AGENT_WARM_E2E_OK";
const E2E_USER_MESSAGE = `Reply with exactly: ${E2E_MARKER}`;

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, ok, detail = "") {
  if (ok) {
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
    const withChat = list.find((a) => a?.id && a?.agentChat?.enabled);
    return withChat?.id ?? list.find((a) => a?.id)?.id ?? null;
  } catch {
    return null;
  }
}

function pickSubAgentIdFromLocal(appId) {
  if (subAgentIdArg) return subAgentIdArg;
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const app = list.find((a) => a?.id === appId);
    return app?.agentChat?.subAgentId ?? "app-assistant";
  } catch {
    return "app-assistant";
  }
}

async function memoryFetch(path, { method = "GET", body = null, headers = {} } = {}) {
  const key = process.env.PAPR_API_KEY;
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "X-API-Key": key } : {}),
      ...(hostKey ? { "X-Cloud-App-Host-Key": hostKey } : {}),
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
  return { status: resp.status, data, text, headers: resp.headers };
}

function runtimeAuthBody(ctx) {
  return {
    namespaceId: ctx.namespaceId,
    slug: ctx.slug,
    paprApiKey: process.env.PAPR_API_KEY,
  };
}

function appAgentBaseBody(ctx, sessionId) {
  return {
    ...runtimeAuthBody(ctx),
    sessionId,
    appId: ctx.appId,
    subAgentId: ctx.subAgentId,
    jobId: ctx.jobId,
  };
}

async function resolvePublishContext() {
  if (namespaceArg && slugArg) {
    const appId = appIdArg ?? pickAppId();
    if (!appId) {
      throw new Error("Pass --app-id= when using --namespace/--slug");
    }
    return {
      namespaceId: namespaceArg,
      slug: slugArg,
      appId,
      subAgentId: pickSubAgentIdFromLocal(appId),
      jobId: jobIdArg ?? null,
    };
  }

  const appId = pickAppId();
  if (!appId) {
    throw new Error("No app id — pass --namespace=, --slug=, --app-id= or add apps.json");
  }

  const slug = `app-agent-e2e-${Date.now().toString(36)}`;
  const res = await memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: { appId, slug, visibility: "team", linkPermission: "read" },
  });
  if (res.status !== 200) {
    throw new Error(`publish failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const parts = res.data.shareUrl?.split("/") ?? [];
  const namespaceId = parts[parts.length - 2];
  return {
    appId,
    slug,
    namespaceId,
    shareUrl: res.data.shareUrl,
    subAgentId: pickSubAgentIdFromLocal(appId),
    jobId: jobIdArg ?? null,
  };
}

async function loadAgentChatFromMetadata(ctx) {
  const res = await memoryFetch("/v1/cloud/apps/runtime/repo-file", {
    method: "POST",
    body: {
      namespaceId: ctx.namespaceId,
      slug: ctx.slug,
      relativePath: "metadata.json",
    },
  });
  if (res.status !== 200 || typeof res.data.content !== "string") {
    return null;
  }
  try {
    const metadata = JSON.parse(res.data.content);
    if (metadata.appId && metadata.appId !== ctx.appId) {
      return null;
    }
    return {
      subAgentId:
        metadata.agentChat?.subAgentId ??
        ctx.subAgentId ??
        pickSubAgentIdFromLocal(ctx.appId),
      jobId: metadata.agentChatJobId ?? ctx.jobId ?? null,
      agentChatEnabled: Boolean(metadata.agentChat?.enabled),
    };
  } catch {
    return null;
  }
}

async function enrichContext(ctx) {
  const meta = await loadAgentChatFromMetadata(ctx);
  if (meta) {
    ctx.subAgentId = meta.subAgentId;
    if (meta.jobId) ctx.jobId = meta.jobId;
    ctx.agentChatEnabled = meta.agentChatEnabled;
  } else {
    ctx.subAgentId = ctx.subAgentId ?? pickSubAgentIdFromLocal(ctx.appId);
    ctx.agentChatEnabled = undefined;
  }
  if (!ctx.jobId && jobIdArg) ctx.jobId = jobIdArg;
  return ctx;
}

function parseSseEvents(rawText) {
  const events = [];
  for (const block of rawText.split("\n\n")) {
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ type: "raw", payload });
    }
  }
  return events;
}

async function readFetchSse(url, { method = "GET", headers = {}, body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, events: parseSseEvents(text) };
}

async function testRouteRegistration() {
  console.log(`\n${BOLD}--- Route registration ---${RESET}`);

  const noKey = await memoryFetch("/v1/cloud/apps/runtime/app-agent/warm", {
    method: "POST",
    headers: { "X-Cloud-App-Host-Key": "" },
    body: {
      namespaceId: "ns-test",
      slug: "test-app",
      sessionId: "sess-test",
      appId: "app-test",
      subAgentId: "assistant",
      jobId: "job-test",
      paprApiKey: "sk-test",
    },
  });

  if (noKey.status === 404) {
    check("POST app-agent/warm exists", false, "404 — deploy memory with app-agent routes");
    return false;
  }
  check(
    "POST app-agent/warm exists",
    noKey.status === 401 || noKey.status === 403 || noKey.status === 422,
    `status=${noKey.status} ${noKey.text.slice(0, 80)}`,
  );

  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
  if (!hostKey) {
    skip("host key validation", "PAPR_CLOUD_APP_HOST_KEY not set");
    return true;
  }

  const badKey = await memoryFetch("/v1/cloud/apps/runtime/app-agent/warm", {
    method: "POST",
    headers: { "X-Cloud-App-Host-Key": "intentionally-wrong-key" },
    body: {
      namespaceId: "ns-test",
      slug: "test-app",
      sessionId: "sess-test",
      appId: "app-test",
      subAgentId: "assistant",
      jobId: "job-test",
      paprApiKey: process.env.PAPR_API_KEY ?? "sk-test",
    },
  });
  check("invalid host key → 401", badKey.status === 401, `status=${badKey.status}`);
  return true;
}

async function testGatewayHealth() {
  if (skipGateway || !gatewayBase) {
    skip("gateway health", skipGateway ? "--skip-gateway" : "no --gateway / CLOUD_AGENT_GATEWAY_URL");
    return;
  }
  console.log(`\n${BOLD}--- Cloud Agent Gateway health ---${RESET}`);
  const gatewayKey = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY;
  if (!gatewayKey) {
    skip("gateway health", "PAPR_CLOUD_AGENT_GATEWAY_KEY not set");
    return;
  }
  try {
    const res = await fetch(`${gatewayBase}/health`, {
      headers: { "X-Cloud-Agent-Gateway-Key": gatewayKey },
    });
    check("GET /health → 200", res.ok, `status=${res.status}`);
    if (res.ok) {
      const body = await res.json();
      check("mode=cloud_agent", body.mode === "cloud_agent", JSON.stringify(body));
    }
  } catch (e) {
    check("gateway reachable", false, e.message);
  }
}

async function testMemoryWarm(ctx, sessionId) {
  console.log(`\n${BOLD}--- Memory POST app-agent/warm ---${RESET}`);

  if (!process.env.PAPR_CLOUD_APP_HOST_KEY) {
    skip("memory warm", "PAPR_CLOUD_APP_HOST_KEY missing");
    return;
  }
  if (!ctx.jobId) {
    skip(
      "memory warm",
      "jobId missing — enable_app_agent_chat + republish, or pass --job-id=",
    );
    return;
  }

  const res = await memoryFetch("/v1/cloud/apps/runtime/app-agent/warm", {
    method: "POST",
    body: appAgentBaseBody(ctx, sessionId),
  });

  if (res.status === 503 && String(res.text).includes("gateway")) {
    skip("memory warm", "Cloud Agent Gateway not configured on memory server");
    return;
  }

  check("warm → 200", res.status === 200, res.text.slice(0, 300));
  if (res.status === 200) {
    check(
      "status ready|warming",
      res.data.status === "ready" || res.data.status === "warming",
      JSON.stringify(res.data),
    );
    check("sessionId echoed", res.data.sessionId === sessionId, res.data.sessionId);
  }
}

async function testMemoryStream(ctx, sessionId) {
  console.log(`\n${BOLD}--- Memory POST app-agent/stream (SSE) ---${RESET}`);

  if (warmOnly) {
    skip("memory stream", "--warm-only");
    return;
  }
  if (!process.env.PAPR_CLOUD_APP_HOST_KEY) {
    skip("memory stream", "PAPR_CLOUD_APP_HOST_KEY missing");
    return;
  }
  if (!ctx.jobId) {
    skip("memory stream", "jobId missing");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    skip("memory stream", "ANTHROPIC_API_KEY missing — live LLM turn skipped");
    return;
  }

  const prompt = `USER: ${E2E_USER_MESSAGE}`;
  const res = await readFetchSse(`${memoryBase}/v1/cloud/apps/runtime/app-agent/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.PAPR_API_KEY ?? "",
      "X-Cloud-App-Host-Key": process.env.PAPR_CLOUD_APP_HOST_KEY ?? "",
    },
    body: {
      ...appAgentBaseBody(ctx, sessionId),
      userMessage: E2E_USER_MESSAGE,
      prompt,
    },
  });

  if (res.status === 503 && res.text.includes("gateway")) {
    skip("memory stream", "Cloud Agent Gateway not configured on memory server");
    return;
  }

  check("stream → 200", res.status === 200, res.text.slice(0, 300));
  check("SSE data events", res.events.length > 0, `events=${res.events.length}`);

  const combined = res.events
    .map((ev) => {
      if (ev.type === "text-delta" && ev.payload?.text) return ev.payload.text;
      if (ev.type === "text-delta" && ev.text) return ev.text;
      if (typeof ev.payload === "string") return ev.payload;
      return JSON.stringify(ev);
    })
    .join("");

  check(
    "stream contains marker or done",
    combined.includes(E2E_MARKER) ||
      res.events.some((ev) => ev.type === "done" || ev.type === "turn-done"),
    combined.slice(0, 200),
  );
}

function hostHeaders(ctx) {
  return {
    "Content-Type": "application/json",
    "X-Papr-Namespace-Id": ctx.namespaceId,
    "X-Papr-Slug": ctx.slug,
    ...(process.env.PAPR_API_KEY ? { "X-API-Key": process.env.PAPR_API_KEY } : {}),
  };
}

async function testHostFlow(ctx, sessionId) {
  console.log(`\n${BOLD}--- Cloud App Host /api/app-agent/* ---${RESET}`);

  if (memoryOnly) {
    skip("host flow", "--memory-only");
    return;
  }

  try {
    const health = await fetch(`${host}/health`);
    if (!health.ok) {
      check("host running", false, `health ${health.status}`);
      return;
    }
  } catch (e) {
    skip("host flow", `${e.message} — npm run start:cloud-app-host`);
    return;
  }
  check("host running", true);

  const createRes = await fetch(`${host}/api/app-agent/sessions`, {
    method: "POST",
    headers: hostHeaders(ctx),
    body: JSON.stringify({ appId: ctx.appId }),
  });
  const createText = await createRes.text();
  let createData;
  try {
    createData = JSON.parse(createText);
  } catch {
    createData = {};
  }

  if (createRes.status === 404) {
    skip("host session create", "agent chat not enabled on published app metadata");
    return;
  }
  check("POST /api/app-agent/sessions → 200", createRes.status === 200, createText.slice(0, 200));

  const hostSessionId = createData.sessionId ?? sessionId;

  const warmRes = await fetch(`${host}/api/app-agent/sessions/${hostSessionId}/warm`, {
    method: "POST",
    headers: hostHeaders(ctx),
  });
  const warmText = await warmRes.text();
  let warmData;
  try {
    warmData = JSON.parse(warmText);
  } catch {
    warmData = {};
  }

  check(
    "POST warm → 200|202",
    warmRes.status === 200 || warmRes.status === 202,
    warmText.slice(0, 200),
  );
  if (warmRes.status === 200 || warmRes.status === 202) {
    check(
      "warm status ready|warming|failed",
      ["ready", "warming", "failed"].includes(warmData.status),
      JSON.stringify(warmData),
    );
  }

  if (warmOnly) {
    skip("host message stream", "--warm-only");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    skip("host message stream", "ANTHROPIC_API_KEY missing");
    return;
  }

  const msgRes = await fetch(`${host}/api/app-agent/sessions/${hostSessionId}/messages`, {
    method: "POST",
    headers: hostHeaders(ctx),
    body: JSON.stringify({ message: E2E_USER_MESSAGE }),
  });
  const msgText = await msgRes.text();
  let msgData;
  try {
    msgData = JSON.parse(msgText);
  } catch {
    msgData = {};
  }
  check("POST messages → 200", msgRes.status === 200, msgText.slice(0, 200));
  if (msgRes.status !== 200 || !msgData.turnId) {
    return;
  }

  const streamRes = await readFetchSse(
    `${host}/api/app-agent/sessions/${hostSessionId}/stream?turnId=${encodeURIComponent(msgData.turnId)}`,
    { headers: hostHeaders(ctx) },
  );
  check("GET stream → 200", streamRes.status === 200, streamRes.text.slice(0, 200));
  check("host SSE events", streamRes.events.length > 0, `events=${streamRes.events.length}`);
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}App-Agent Warm E2E${RESET}`);
  console.log(`Memory:  ${memoryBase}`);
  console.log(`Host:    ${host}`);
  if (gatewayBase) console.log(`Gateway: ${gatewayBase}`);
  console.log("=".repeat(70));

  console.log(`\n${BOLD}--- Health ---${RESET}`);
  try {
    const health = await fetch(`${memoryBase}/health`);
    check("GET /health → 200", health.ok, `status=${health.status}`);
  } catch (e) {
    check("memory reachable", false, e.message);
    process.exit(1);
  }

  if (!process.env.PAPR_API_KEY) {
    console.log(`\n${RED}PAPR_API_KEY missing (set in .env.local)${RESET}`);
    process.exit(1);
  }

  const routesOk = await testRouteRegistration();
  await testGatewayHealth();

  if (!routesOk) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(
      `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  let ctx;
  try {
    ctx = await resolvePublishContext();
    ctx = await enrichContext(ctx);
  } catch (e) {
    skip("integration context", e.message);
    console.log(`\n${"=".repeat(70)}`);
    console.log(
      `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  const sessionId = sessionIdArg ?? randomUUID();

  console.log(`\n${BOLD}Context${RESET}`);
  console.log(`  namespace: ${ctx.namespaceId}`);
  console.log(`  slug:      ${ctx.slug}`);
  console.log(`  appId:     ${ctx.appId}`);
  console.log(`  subAgent:  ${ctx.subAgentId}`);
  console.log(`  jobId:     ${ctx.jobId ?? "(missing — pass --job-id= or republish with agent chat)"}`);
  console.log(`  session:   ${sessionId}`);
  if (ctx.agentChatEnabled === false) {
    console.log(
      `  ${YELLOW}warning:${RESET} metadata.json agentChat.enabled is false — warm/stream may 404`,
    );
  }

  await testMemoryWarm(ctx, sessionId);
  await testMemoryStream(ctx, sessionId);
  await testHostFlow(ctx, sessionId);

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
  );

  if (failed > 0) {
    console.log(`\n${BOLD}Fix checklist:${RESET}`);
    console.log("1. Deploy memory with app-agent warm/stream routes");
    console.log("2. Set CLOUD_AGENT_GATEWAY_URL + PAPR_CLOUD_AGENT_GATEWAY_KEY on memory");
    console.log("3. enable_app_agent_chat + publish_cloud_app (metadata.json agentChatJobId)");
    console.log("4. npm run start:cloud-app-host for host-side tests");
    console.log("5. ANTHROPIC_API_KEY in .env.local for live stream turns");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e.message);
  process.exit(1);
});
