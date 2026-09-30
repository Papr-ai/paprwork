#!/usr/bin/env node
/**
 * E2E: App-agent warm session storage — stable chatId + per-sandbox chats.db
 *
 * Tests the Cloud Agent Gateway directly (bypasses memory server) so you can
 * validate paprwork-v2 changes before deploy.
 *
 * Flow:
 *   1. Resolve app-agent subagent job from local apps.json (or --job-id=)
 *   2. Optional: start local gateway (--start-gateway)
 *   3. POST /internal/agent/session/begin (warm clone)
 *   4. POST /internal/agent/stream turn 1 — codeword task
 *   5. POST /internal/agent/stream turn 2 — recall codeword (proves chats.db history)
 *
 * Pass criteria:
 *   - session-meta + done events use chatId app-agent:{sessionId}
 *   - Turn 2 assistant text includes the codeword from turn 1
 *
 * Prerequisites (.env.local):
 *   PAPR_API_KEY, ANTHROPIC_API_KEY
 *   App with enable_app_agent_chat synced to GitHub (cloud job id in apps.json)
 *
 * Usage:
 *   npm run test:app-agent-storage-e2e -- --start-gateway
 *   npm run test:app-agent-storage-e2e -- --job-id=UUID --start-gateway
 *   npm run test:app-agent-storage-e2e -- --gateway=https://papr-cloud-agent-gateway-....run.app
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const args = process.argv.slice(2);

const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "https://memory.papr.ai"
).replace(/\/$/, "");

const gatewayBase = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  process.env.CLOUD_AGENT_GATEWAY_URL ??
  "http://127.0.0.1:8788"
).replace(/\/$/, "");

const jobIdArg = args.find((a) => a.startsWith("--job-id="))?.split("=")[1];
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const namespaceArg = args.find((a) => a.startsWith("--namespace="))?.split("=")[1];
const orgArg = args.find((a) => a.startsWith("--org="))?.split("=")[1];
const sessionIdArg = args.find((a) => a.startsWith("--session-id="))?.split("=")[1];
const startGateway = args.includes("--start-gateway");
const warmOnly = args.includes("--warm-only");

const CODEWORD = `PAPR_STORAGE_${randomBytes(4).toString("hex").toUpperCase()}`;
const TURN1_MESSAGE = `Remember this exact codeword: ${CODEWORD}. Reply with exactly: CODeword_ACK`;
const TURN2_MESSAGE = `What exact codeword did I ask you to remember? Reply with ONLY that codeword, nothing else.`;

const GATEWAY_KEY =
  process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ??
  `local-e2e-gateway-key-${randomBytes(8).toString("hex")}`;

let passed = 0;
let failed = 0;
let gatewayProc = null;

function ok(label, detail = "") {
  passed += 1;
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failed += 1;
  console.error(`❌ ${label}${detail ? `: ${detail}` : ""}`);
}

function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function parsePaprApiKeyScope(apiKey) {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

function readActiveWorkspace() {
  try {
    const raw = readFileSync(join(homedir(), "Papr", ".active-workspace.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveAppsJsonPath(pointer) {
  if (pointer?.paprHome) {
    return join(pointer.paprHome, "data", "apps.json");
  }
  return join(homedir(), "Papr", "data", "apps.json");
}

function pickAppAgentJob(appIdFilter) {
  const pointer = readActiveWorkspace();
  const appsPath = resolveAppsJsonPath(pointer);
  if (!existsSync(appsPath)) {
    throw new Error(`apps.json not found at ${appsPath}`);
  }
  const parsed = JSON.parse(readFileSync(appsPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const app = appIdFilter
    ? list.find((a) => a?.id === appIdFilter)
    : list.find((a) => a?.agentChat?.enabled && a?.agentChat?.cloudJobId);
  if (!app?.agentChat?.cloudJobId) {
    throw new Error(
      "No app with agentChat.cloudJobId — run enable_app_agent_chat + sync, or pass --job-id=",
    );
  }
  return {
    appId: app.id,
    appTitle: app.title ?? app.id,
    jobId: app.agentChat.cloudJobId,
    subAgentId: app.agentChat.subAgentId,
    pointer,
  };
}

function isLocalGatewayUrl(url) {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

function cloudRunAuthHeaders() {
  if (isLocalGatewayUrl(gatewayBase)) return {};
  try {
    const token = execSync("gcloud auth print-identity-token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

function gatewayHeaders(extra = {}) {
  return {
    "X-Cloud-Agent-Gateway-Key": GATEWAY_KEY,
    ...cloudRunAuthHeaders(),
    ...extra,
  };
}

async function memoryFetch(path, { method = "GET", body = null } = {}) {
  const paprApiKey = process.env.PAPR_API_KEY;
  const res = await fetch(`${memoryBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": paprApiKey ?? "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function getRepoToken() {
  const res = await memoryFetch("/v1/cloud/repos/token", {
    method: "POST",
    body: { scope: "user" },
  });
  if (res.status !== 200) {
    throw new Error(`repos/token failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const userRepo = res.data.repos?.find((r) => r.scope === "user");
  if (!userRepo?.cloneUrl) {
    throw new Error("No user repo in token response");
  }
  return {
    token: res.data.token,
    cloneUrl: userRepo.cloneUrl,
    branch: userRepo.defaultBranch ?? "main",
  };
}

function jobTursoShortName(jobId) {
  return `j-${jobId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

async function fetchTursoOptional(jobId) {
  const db = jobTursoShortName(jobId);
  const res = await memoryFetch("/v1/cloud/databases/token", {
    method: "POST",
    body: { database: db, scope: "user" },
  });
  if (res.status !== 200) return null;
  return {
    jobId,
    databaseUrl: res.data.tursoUrl,
    authToken: res.data.authToken,
  };
}

function parseSseEvents(rawText) {
  const events = [];
  for (const block of rawText.split("\n\n")) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
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

function extractAssistantText(events) {
  let text = "";
  for (const ev of events) {
    if (ev.type === "text-delta") {
      const chunk =
        typeof ev.payload?.text === "string"
          ? ev.payload.text
          : typeof ev.text === "string"
            ? ev.text
            : "";
      text += chunk;
    }
  }
  return text.trim();
}

function summarizeStreamEvents(events, label) {
  const counts = {};
  for (const ev of events) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  }
  console.log(`  [${label}] event types:`, JSON.stringify(counts));
  for (const ev of events) {
    if (ev.type === "error") {
      console.log(`  [${label}] error:`, ev.message ?? ev.payload?.error ?? JSON.stringify(ev));
    }
  }
}

async function waitForGateway(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${gatewayBase}/health`, { headers: gatewayHeaders() });
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return body;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Gateway not ready at ${gatewayBase}`);
}

function startLocalGateway() {
  return new Promise((resolve, reject) => {
    gatewayProc = spawn("npm", ["run", "start:cloud-agent-gateway"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAPR_CLOUD_AGENT_GATEWAY_KEY: GATEWAY_KEY,
        CLOUD_AGENT_GATEWAY_PORT: "8788",
        PAPR_MEMORY_SERVER_URL: memoryBase,
        PAPR_API_KEY: process.env.PAPR_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let booted = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[gateway] ${text}`);
      if (!booted && text.includes("Listening")) {
        booted = true;
        resolve();
      }
    };
    gatewayProc.stdout.on("data", onData);
    gatewayProc.stderr.on("data", onData);
    gatewayProc.on("error", reject);
    gatewayProc.on("exit", (code) => {
      if (!booted) reject(new Error(`Gateway exited early (${code})`));
    });
    setTimeout(() => {
      if (!booted) resolve();
    }, 60_000);
  });
}

function cleanup() {
  if (gatewayProc && !gatewayProc.killed) {
    gatewayProc.kill("SIGTERM");
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function buildWarmRequest({
  sessionId,
  jobId,
  orgId,
  namespaceId,
  repoToken,
  cloneUrl,
  branch,
  userMessage,
}) {
  const paprApiKey = process.env.PAPR_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const turso = await fetchTursoOptional(jobId);

  return {
    orgId,
    namespaceId,
    userId: "e2e-app-agent-user",
    jobId,
    runId: randomBytes(6).toString("hex"),
    paprApiKey,
    repoCloneUrl: cloneUrl,
    repoToken,
    repoBranch: branch,
    turso,
    workspaceSessionId: sessionId,
    keepWorkspaceWarm: true,
    runtimeParams: { prompt: userMessage },
    llmAuth: {
      provider: "anthropic",
      authType: anthropicKey?.startsWith("sk-ant-oat") ? "oauth" : "apiKey",
      token: anthropicKey,
    },
    maxTurns: 12,
  };
}

async function gatewayStream(request) {
  const res = await fetch(`${gatewayBase}/internal/agent/stream`, {
    method: "POST",
    headers: gatewayHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(request),
  });
  const text = await res.text();
  return { status: res.status, text, events: parseSseEvents(text) };
}

async function gatewayBegin(request) {
  const res = await fetch(`${gatewayBase}/internal/agent/session/begin`, {
    method: "POST",
    headers: gatewayHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(request),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
}

function assertChatId(events, sessionId) {
  const expected = `app-agent:${sessionId}`;
  const meta = events.find((ev) => ev.type === "session-meta");
  const done = events.filter((ev) => ev.type === "done");
  if (meta?.chatId === expected) {
    ok("session-meta chatId", expected);
  } else {
    fail("session-meta chatId", `expected ${expected}, got ${meta?.chatId ?? "missing"}`);
  }
  if (done.every((ev) => ev.chatId === expected)) {
    ok("done chatId", expected);
  } else {
    fail(
      "done chatId",
      done.map((ev) => ev.chatId).join(", ") || "no done event",
    );
  }
}

async function main() {
  loadEnvLocal();

  console.log("\nApp-Agent Storage E2E (gateway direct)");
  console.log(`  memory:  ${memoryBase}`);
  console.log(`  gateway: ${gatewayBase}`);
  console.log(`  codeword: ${CODEWORD}`);
  console.log("");

  if (!process.env.PAPR_API_KEY) {
    fail("PAPR_API_KEY", "missing from .env.local");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY", "missing from .env.local");
    process.exit(1);
  }
  ok("API keys loaded");

  const keyScope = parsePaprApiKeyScope(process.env.PAPR_API_KEY);
  const activeWs = readActiveWorkspace();
  const scope = (() => {
    if (orgArg && namespaceArg) {
      return { organizationId: orgArg, namespaceId: namespaceArg };
    }
    // Prefer active workspace so apps.json job ids match the cloned git repo.
    if (activeWs?.organizationId && activeWs?.namespaceId) {
      return {
        organizationId: activeWs.organizationId,
        namespaceId: activeWs.namespaceId,
      };
    }
    if (keyScope) {
      return {
        organizationId: keyScope.organizationId,
        namespaceId: keyScope.namespaceId,
      };
    }
    return null;
  })();

  if (!scope) {
    fail("org/namespace scope", "set active workspace, PAPR_API_KEY scope, or --org/--namespace");
    process.exit(1);
  }
  if (
    keyScope &&
    activeWs?.namespaceId &&
    keyScope.namespaceId !== activeWs.namespaceId &&
    !namespaceArg
  ) {
    console.warn(
      `⚠ PAPR_API_KEY namespace (${keyScope.namespaceId}) ≠ active workspace (${activeWs.namespaceId}). ` +
        "Using active workspace for clone — ensure PAPR_API_KEY has access.",
    );
  }
  ok("workspace scope", `${scope.organizationId}/${scope.namespaceId}`);

  let jobContext;
  try {
    if (jobIdArg) {
      jobContext = {
        jobId: jobIdArg,
        appId: appIdArg ?? "unknown",
        pointer: readActiveWorkspace(),
      };
    } else {
      jobContext = pickAppAgentJob(appIdArg);
    }
    ok("app-agent job", `${jobContext.appTitle ?? jobContext.appId} → ${jobContext.jobId}`);
  } catch (e) {
    fail("resolve app-agent job", e.message);
    process.exit(1);
  }

  if (startGateway) {
    console.log("\nStarting local Cloud Agent Gateway…");
    await startLocalGateway();
    await waitForGateway();
    ok("local gateway ready", gatewayBase);
  } else {
    await waitForGateway();
    ok("gateway reachable", gatewayBase);
  }

  const { token, cloneUrl, branch } = await getRepoToken();
  ok("GitHub repo token");

  const sessionId = sessionIdArg ?? randomUUID();
  console.log(`\nSession: ${sessionId}`);
  console.log(`Expected chatId: app-agent:${sessionId}\n`);

  const beginBody = await buildWarmRequest({
    sessionId,
    jobId: jobContext.jobId,
    orgId: scope.organizationId,
    namespaceId: scope.namespaceId,
    repoToken: token,
    cloneUrl,
    branch,
    userMessage: TURN1_MESSAGE,
  });

  const beginRes = await gatewayBegin(beginBody);
  if (beginRes.status === 200 || beginRes.status === 202) {
    ok("session/begin", beginRes.data.status ?? beginRes.status);
  } else {
    fail("session/begin", `${beginRes.status} ${beginRes.text.slice(0, 300)}`);
    process.exit(1);
  }

  if (warmOnly) {
    console.log(`\nWarm-only — skipping stream turns`);
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log("\n--- Turn 1 (store codeword) ---");
  const turn1Req = await buildWarmRequest({
    sessionId,
    jobId: jobContext.jobId,
    orgId: scope.organizationId,
    namespaceId: scope.namespaceId,
    repoToken: token,
    cloneUrl,
    branch,
    userMessage: TURN1_MESSAGE,
  });
  const turn1 = await gatewayStream(turn1Req);
  if (turn1.status !== 200) {
    fail("turn 1 stream", `${turn1.status} ${turn1.text.slice(0, 400)}`);
    process.exit(1);
  }
  ok("turn 1 stream → 200");
  summarizeStreamEvents(turn1.events, "turn1");
  assertChatId(turn1.events, sessionId);
  const turn1Text = extractAssistantText(turn1.events);
  if (turn1Text.includes("CODeword_ACK") || turn1Text.includes(CODEWORD)) {
    ok("turn 1 acknowledged codeword");
  } else {
    fail("turn 1 acknowledged codeword", turn1Text.slice(0, 200));
  }

  console.log("\n--- Turn 2 (recall from chats.db) ---");
  const turn2Req = await buildWarmRequest({
    sessionId,
    jobId: jobContext.jobId,
    orgId: scope.organizationId,
    namespaceId: scope.namespaceId,
    repoToken: token,
    cloneUrl,
    branch,
    userMessage: TURN2_MESSAGE,
  });
  const turn2 = await gatewayStream(turn2Req);
  if (turn2.status !== 200) {
    fail("turn 2 stream", `${turn2.status} ${turn2.text.slice(0, 400)}`);
    process.exit(1);
  }
  ok("turn 2 stream → 200");
  summarizeStreamEvents(turn2.events, "turn2");
  assertChatId(turn2.events, sessionId);
  const turn2Text = extractAssistantText(turn2.events);
  if (turn2Text.includes(CODEWORD)) {
    ok("turn 2 recalled codeword from session history", CODEWORD);
  } else {
    fail(
      "turn 2 recalled codeword",
      `expected ${CODEWORD} in "${turn2Text.slice(0, 200)}"`,
    );
  }

  const turn2Done = turn2.events.find((ev) => ev.type === "done");
  if (turn2Done?.exitCode === 0) {
    ok("turn 2 exitCode 0");
  } else {
    fail("turn 2 exitCode", String(turn2Done?.exitCode ?? "missing"));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFix checklist:");
    console.log("1. Rebuild/restart gateway with latest paprwork-v2 changes");
    console.log("2. enable_app_agent_chat + sync job to GitHub");
    console.log("3. Memory server must pass runtimeParams.prompt = user message only");
    console.log("4. Deploy cloud-agent-gateway before production app-host-only deploy");
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  cleanup();
  process.exit(1);
});
