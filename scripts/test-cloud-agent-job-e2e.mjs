#!/usr/bin/env node
/**
 * E2E: Cloud Agent Gateway — clone git repo, run full AgentService, verify output.
 *
 * Flow:
 *   1. (Optional) Sync a local ~/Papr job into the user's GitHub cloud repo
 *   2. Sync ANTHROPIC_API_KEY to vault (for production memory path)
 *   3. POST run context → local or deployed Cloud Agent Gateway
 *
 * Prerequisites:
 *   - PAPR_API_KEY in .env.local or env
 *   - ANTHROPIC_API_KEY in .env.local (for LLM auth)
 *   - Cloud Agent Gateway running (script can start it with --start-gateway)
 *
 * Usage:
 *   node scripts/test-cloud-agent-job-e2e.mjs --start-gateway
 *   node scripts/test-cloud-agent-job-e2e.mjs --job-id e2e-cloud-agent-0001
 *   node scripts/test-cloud-agent-job-e2e.mjs --sync-local 8127d1bc-27d1-4c9c-b420-d3a0c899bb59 --e2e-prompt --start-gateway
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { spawn, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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

const startGateway = args.includes("--start-gateway");
const e2ePrompt = args.includes("--e2e-prompt");
const browserE2e = args.includes("--browser-e2e");
const viaMemory = args.includes("--via-memory");

const syncLocalArg = args.find((a) => a.startsWith("--sync-local="))?.split("=")[1];
const jobIdArg =
  args.find((a) => a.startsWith("--job-id="))?.split("=")[1] ??
  (syncLocalArg ? syncLocalArg : "e2e-cloud-agent-0001");

const E2E_MARKER = "CLOUD_AGENT_GATEWAY_OK";
const E2E_COMMAND = `Use the bash tool once: run \`echo ${E2E_MARKER}\`. Then reply with exactly: ${E2E_MARKER}`;
const E2E_BROWSER_COMMAND =
  `Use browser_navigate to open https://example.com, then browser_snapshot once. ` +
  `If the page loaded, reply with exactly: ${E2E_MARKER}`;

const GATEWAY_KEY =
  process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ??
  "local-e2e-gateway-key-" + randomBytes(8).toString("hex");

function isLocalGatewayUrl(url) {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

function cloudRunAuthHeaders() {
  if (isLocalGatewayUrl(gatewayBase)) {
    return {};
  }
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

loadEnvLocal();

function loadApiKey() {
  return process.env.PAPR_API_KEY ?? null;
}

function loadAnthropicKey() {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

const paprApiKey = loadApiKey();
const anthropicKey = loadAnthropicKey();

if (!paprApiKey) {
  console.error("❌ PAPR_API_KEY required (.env.local or env)");
  process.exit(1);
}
if (!anthropicKey) {
  console.error("❌ ANTHROPIC_API_KEY required for agent gateway E2E");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let gatewayProc = null;

function ok(label) {
  passed += 1;
  console.log(`✅ ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`❌ ${label}: ${detail}`);
}

async function memoryFetch(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${memoryBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": paprApiKey,
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
  return { token: res.data.token, cloneUrl: userRepo.cloneUrl, branch: userRepo.defaultBranch ?? "main" };
}

function parseOwnerRepo(cloneUrl) {
  const pathPart = cloneUrl.replace("https://github.com/", "").replace(".git", "");
  const [owner, repo] = pathPart.split("/");
  return { owner, repo };
}

async function githubGetFile({ token, owner, repo, path }) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed (${res.status})`);
  return res.json();
}

async function githubPutFile({ token, owner, repo, path, content, message, sha }) {
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function loadLocalJob(jobId) {
  const jobsPath = join(homedir(), "Papr", "data", "jobs.json");
  const jobs = JSON.parse(readFileSync(jobsPath, "utf8"));
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs);
  const job = list.find((j) => j.id === jobId || j.id.startsWith(jobId));
  if (!job) throw new Error(`Local job not found: ${jobId}`);
  const jobsRoot = existsSync(join(homedir(), "Papr", "Jobs"))
    ? join(homedir(), "Papr", "Jobs")
    : join(homedir(), "Papr", "jobs");
  const jobDir = join(jobsRoot, job.id);
  let folderJob = job;
  const jobJsonPath = join(jobDir, "job.json");
  if (existsSync(jobJsonPath)) {
    folderJob = { ...job, ...JSON.parse(readFileSync(jobJsonPath, "utf8")) };
  }
  return { job: folderJob, jobDir };
}

function collectJobFiles(jobDir) {
  const skip = new Set([
    "venv",
    ".venv",
    "node_modules",
    "__pycache__",
    "logs",
    "dist",
    ".versions",
  ]);
  const skipExt = [".db", ".db-wal", ".db-shm", ".log", ".wav"];
  const files = [];

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        walk(full);
        continue;
      }
      if (skipExt.some((ext) => name.endsWith(ext))) continue;
      if (st.size > 500_000) continue;
      files.push(full);
    }
  }

  if (existsSync(jobDir)) walk(jobDir);
  return files;
}

async function syncLocalJobToGithub({ token, owner, repo, jobId, useE2ePrompt }) {
  const { job, jobDir } = loadLocalJob(jobId);
  const cloudId = job.id;
  const jobsPath = "data/jobs.json";
  const existing = await githubGetFile({ token, owner, repo, path: jobsPath });
  let jobs = [];
  if (existing?.content) {
    jobs = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
    if (!Array.isArray(jobs)) jobs = Object.values(jobs);
  }

  const now = new Date().toISOString();
  const cloudJob = {
    ...job,
    id: cloudId,
    type: "agent",
    provider: job.provider ?? "anthropic",
    model: job.model ?? "claude-sonnet-4-6",
    command: useE2ePrompt ? E2E_COMMAND : job.command ?? E2E_COMMAND,
    status: "idle",
    updatedAt: now,
    lastRunAt: job.lastRunAt ?? null,
    lastOutput: job.lastOutput ?? null,
  };

  const idx = jobs.findIndex((j) => j?.id === cloudId);
  if (idx >= 0) jobs[idx] = { ...jobs[idx], ...cloudJob };
  else jobs.push(cloudJob);

  await githubPutFile({
    token,
    owner,
    repo,
    path: jobsPath,
    content: `${JSON.stringify(jobs, null, 2)}\n`,
    message: `e2e: sync local agent job ${cloudJob.name}`,
    sha: existing?.sha,
  });

  const files = collectJobFiles(jobDir);
  for (const filePath of files.slice(0, 40)) {
    const rel = relative(jobDir, filePath).replace(/\\/g, "/");
    const ghPath = `Jobs/${cloudId}/${rel}`;
    const ghExisting = await githubGetFile({ token, owner, repo, path: ghPath });
    const content = readFileSync(filePath, "utf8");
    await githubPutFile({
      token,
      owner,
      repo,
      path: ghPath,
      content,
      message: `e2e: sync ${rel} for ${cloudJob.name}`,
      sha: ghExisting?.sha,
    });
  }

  if (files.length === 0) {
    const readmePath = `Jobs/${cloudId}/README.md`;
    const ghExisting = await githubGetFile({ token, owner, repo, path: readmePath });
    if (!ghExisting) {
      await githubPutFile({
        token,
        owner,
        repo,
        path: readmePath,
        content: `# ${cloudJob.name}\n\nCloud E2E agent job workspace.\n`,
        message: `e2e: add workspace for ${cloudJob.name}`,
      });
    }
  }

  await new Promise((r) => setTimeout(r, 4000));
  return cloudId;
}

async function ensureE2eAgentJob({ token, owner, repo }) {
  const jobsPath = "data/jobs.json";
  const existing = await githubGetFile({ token, owner, repo, path: jobsPath });
  let jobs = [];
  if (existing?.content) {
    jobs = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
    if (!Array.isArray(jobs)) jobs = Object.values(jobs);
  }

  const now = new Date().toISOString();
  const testJob = {
    id: "e2e-cloud-agent-0001",
    name: "E2E Cloud Agent Gateway Test",
    type: "agent",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    command: E2E_COMMAND,
    status: "idle",
    appIds: ["__standalone__"],
    createdAt: now,
    updatedAt: now,
  };

  const idx = jobs.findIndex((j) => j?.id === testJob.id);
  if (idx >= 0) jobs[idx] = { ...jobs[idx], ...testJob };
  else jobs.push(testJob);

  await githubPutFile({
    token,
    owner,
    repo,
    path: jobsPath,
    content: `${JSON.stringify(jobs, null, 2)}\n`,
    message: "e2e: ensure cloud agent gateway test job",
    sha: existing?.sha,
  });

  const readmePath = "Jobs/e2e-cloud-agent-0001/README.md";
  const dirFile = await githubGetFile({ token, owner, repo, path: readmePath });
  if (!dirFile) {
    await githubPutFile({
      token,
      owner,
      repo,
      path: readmePath,
      content: "# E2E Cloud Agent Gateway Test\n",
      message: "e2e: add agent test job workspace",
    });
  }

  await new Promise((r) => setTimeout(r, 3000));
  return testJob.id;
}

async function syncVaultAnthropicKey() {
  const res = await memoryFetch("/v1/cloud/vault/sync", {
    method: "POST",
    body: {
      scope: "user",
      keys: [
        {
          name: "ANTHROPIC_API_KEY",
          value: anthropicKey,
          source: anthropicKey.startsWith("sk-ant-oat") ? "oauth" : "manual",
        },
      ],
    },
  });
  if (res.status !== 200) {
    throw new Error(`vault/sync failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
}

async function fetchJobFromGithub({ token, owner, repo, jobId }) {
  const jobsFile = await githubGetFile({ token, owner, repo, path: "data/jobs.json" });
  if (!jobsFile?.content) throw new Error("jobs.json missing on GitHub");
  const jobs = JSON.parse(Buffer.from(jobsFile.content, "base64").toString("utf8"));
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs);
  const job = list.find((j) => j?.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not in GitHub jobs.json`);
  return job;
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

async function buildGatewayRequest({ job, repoToken, cloneUrl, branch, jobId }) {
  const turso = await fetchTursoOptional(jobId);
  const prompt = browserE2e
    ? E2E_BROWSER_COMMAND
    : e2ePrompt
      ? E2E_COMMAND
      : job.command ?? E2E_COMMAND;
  const provider = job.provider ?? "anthropic";
  const model = job.model ?? "claude-sonnet-4-6";

  return {
    orgId: "e2e-org",
    userId: "e2e-user",
    jobId,
    runId: randomBytes(6).toString("hex"),
    model,
    prompt,
    paprApiKey,
    repoCloneUrl: cloneUrl,
    repoToken,
    repoBranch: branch,
    turso,
    llmAuth: {
      provider: provider === "openai-codex" ? "openai" : provider,
      authType: anthropicKey.startsWith("sk-ant-oat") ? "oauth" : "apiKey",
      token: anthropicKey,
    },
    maxTurns: 8,
  };
}

async function waitForGateway(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${gatewayBase}/health`, {
        headers: gatewayHeaders(),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return body;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Gateway not ready at ${gatewayBase}`);
}

function startLocalGateway() {
  return new Promise((resolve, reject) => {
    gatewayProc = spawn(
      "npm",
      ["run", "start:cloud-agent-gateway"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PAPR_CLOUD_AGENT_GATEWAY_KEY: GATEWAY_KEY,
          CLOUD_AGENT_GATEWAY_PORT: "8788",
          PAPR_MEMORY_SERVER_URL: memoryBase,
          PAPR_API_KEY: paprApiKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
    }, 45_000);
  });
}

async function runViaGateway(request) {
  const res = await fetch(`${gatewayBase}/internal/agent/run`, {
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

async function runViaMemory(jobId) {
  return memoryFetch("/v1/cloud/runtime/job-run", {
    method: "POST",
    body: {
      jobId,
      tier: "sandbox",
      timeoutMs: 900_000,
    },
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

console.log(`\nCloud Agent Job E2E`);
console.log(`  memory:  ${memoryBase}`);
console.log(`  gateway: ${gatewayBase}`);
console.log(`  job:     ${jobIdArg}`);
console.log("");

try {
  ok("PAPR_API_KEY loaded");
  ok("ANTHROPIC_API_KEY loaded");

  await syncVaultAnthropicKey();
  ok("vault sync ANTHROPIC_API_KEY");

  const { token, cloneUrl, branch } = await getRepoToken();
  const { owner, repo } = parseOwnerRepo(cloneUrl);
  ok(`GitHub repo ${owner}/${repo}`);

  let runJobId = jobIdArg;
  if (syncLocalArg) {
    runJobId = await syncLocalJobToGithub({
      token,
      owner,
      repo,
      jobId: syncLocalArg,
      useE2ePrompt: e2ePrompt,
    });
    ok(`synced local job → GitHub (${runJobId})`);
  } else if (runJobId === "e2e-cloud-agent-0001") {
    await ensureE2eAgentJob({ token, owner, repo });
    ok("ensured e2e-cloud-agent-0001 on GitHub");
  }

  const job = await fetchJobFromGithub({ token, owner, repo, jobId: runJobId });
  ok(`GitHub job: ${job.name} (${job.provider ?? "anthropic"}/${job.model ?? "default"})`);

  if (startGateway) {
    console.log("\nStarting local Cloud Agent Gateway…");
    await startLocalGateway();
    await waitForGateway();
    ok("gateway health");
  } else {
    await waitForGateway();
    ok("gateway reachable");
  }

  const request = await buildGatewayRequest({
    job,
    repoToken: token,
    cloneUrl,
    branch,
    jobId: runJobId,
  });

  console.log(`\nRunning agent job via gateway (runId=${request.runId})…`);
  console.log(`This may take 30–120s (clone + agent + tools)…\n`);

  const t0 = Date.now();
  const runRes = await runViaGateway(request);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (runRes.status !== 200) {
    fail("gateway /internal/agent/run", `${runRes.status} ${runRes.text.slice(0, 400)}`);
  } else {
    ok(`gateway run completed in ${elapsed}s (exitCode=${runRes.data.exitCode})`);
    const output = String(runRes.data.output ?? "");
    if (output.includes(E2E_MARKER)) {
      ok(`output contains ${E2E_MARKER}`);
    } else if (browserE2e) {
      fail("browser output", `expected ${E2E_MARKER}, got: ${output.slice(0, 300)}`);
    } else if (runRes.data.exitCode === 0 && output.trim().length > 0) {
      ok(`output received (${output.slice(0, 120)}…)`);
    } else {
      fail("output", output.slice(0, 300) || runRes.data.error || "empty output");
    }
    if (runRes.data.chatId) {
      ok(`chatId=${runRes.data.chatId}`);
    }
  }

  if (viaMemory) {
    console.log("\nOptional: memory job-run path…");
    const memRes = await runViaMemory(runJobId);
    if (memRes.status === 200 && memRes.data.backend === "cloud-agent-gateway") {
      ok(`memory job-run used cloud-agent-gateway backend`);
    } else if (memRes.status === 200) {
      fail(
        "memory job-run backend",
        `expected cloud-agent-gateway, got ${memRes.data.backend ?? "unknown"} — set CLOUD_AGENT_GATEWAY_URL on memory server`,
      );
    } else {
      fail("memory job-run", `${memRes.status} ${memRes.text.slice(0, 200)}`);
    }
  }
} catch (err) {
  fail("unexpected", err.message);
  if (err.stack) console.error(err.stack);
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
