#!/usr/bin/env node
/**
 * Pre-deploy gate for app-agent chat (Deck Studio and any published app).
 *
 * Verifies the full chain that causes "Job not found: {jobId}" on apps.papr.ai:
 *   1. Unit tests (subagent recovery + cloud sync paths)
 *   2. Local disk (metadata.json, jobs.json, Jobs/{id}/)
 *   3. Git HEAD (what cloud already has after last sync — simulates production)
 *   4. Optional live cloud repo (memory runtime repo-file API)
 *   5. Optional warm + stream E2E (delegates to test-app-agent-warm-e2e.mjs)
 *
 * Usage:
 *   npm run test:app-agent-deploy-verify -- \
 *     --papr-home=$HOME/Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V \
 *     --app-id=9e70c06b-ac30-4c95-bfe2-adc1daecbeb0
 *
 *   # With live cloud checks (requires PAPR_API_KEY in .env.local):
 *   npm run test:app-agent-deploy-verify -- \
 *     --papr-home=... --app-id=... --namespace=85ZIB7mD1V --slug=deck-studio \
 *     --live-cloud --live-stream
 *
 * Exit 0 only when all required checks pass.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function arg(name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=") ?? null;
}

const paprHome =
  arg("papr-home") ??
  (() => {
    try {
      const ws = JSON.parse(
        readFileSync(join(homedir(), "Papr", ".active-workspace.json"), "utf8"),
      );
      return ws.paprHome ?? null;
    } catch {
      return join(homedir(), "Papr");
    }
  })();

const appId = arg("app-id");
const namespaceId = arg("namespace");
const slug = arg("slug");
const liveCloud = args.includes("--live-cloud");
const liveStream = args.includes("--live-stream");
const skipUnit = args.includes("--skip-unit");

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failed = 0;
let passed = 0;
let warned = 0;

function pass(name, detail = "") {
  console.log(`  ${GREEN}PASS${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

function fail(name, detail = "") {
  console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

function warn(name, detail = "") {
  console.log(`  ${YELLOW}WARN${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
  warned++;
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jobsList(raw) {
  return Array.isArray(raw) ? raw : raw.jobs ?? [];
}

function gitShow(paprDir, relativePath) {
  try {
    return execSync(`git -C "${paprDir}" show "HEAD:${relativePath}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitPorcelain(paprDir, relativePaths) {
  try {
    return execSync(
      `git -C "${paprDir}" status --porcelain -- ${relativePaths.map((p) => `"${p}"`).join(" ")}`,
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

function resolveAgentChatContext(paprDir, targetAppId) {
  const metadataPath = join(paprDir, "apps", targetAppId, "metadata.json");
  if (!existsSync(metadataPath)) {
    return { error: `metadata.json missing: ${metadataPath}` };
  }
  const metadata = readJson(metadataPath);
  const jobId = metadata.agentChatJobId?.trim() ?? null;
  const enabled = Boolean(metadata.agentChat?.enabled);
  const subAgentId = metadata.agentChat?.subAgentId ?? null;
  if (!enabled) {
    return { error: "metadata.agentChat.enabled is false", metadata };
  }
  if (!jobId) {
    return { error: "metadata.agentChatJobId missing", metadata };
  }
  return { jobId, subAgentId, metadata };
}

function subAgentProfileExists(paprDir, subAgentId) {
  if (!subAgentId) {
    return false;
  }
  const subagentsPath = join(paprDir, "data", "subagents.json");
  if (!existsSync(subagentsPath)) {
    return false;
  }
  try {
    const list = readJson(subagentsPath);
    if (!Array.isArray(list)) {
      return false;
    }
    return list.some((p) => p?.id === subAgentId);
  } catch {
    return false;
  }
}

function checkSubAgentProfile(name, paprDir, subAgentId, failOnMissing = true) {
  if (!subAgentId) {
    if (failOnMissing) {
      fail(name, "metadata.agentChat.subAgentId missing");
    } else {
      warn(name, "subAgentId not set");
    }
    return;
  }
  if (subAgentProfileExists(paprDir, subAgentId)) {
    pass(name, subAgentId);
  } else if (failOnMissing) {
    fail(
      name,
      `${subAgentId} missing from data/subagents.json — restart gateway (sidecar recovery) or create_sub_agent to re-upload Mongo registry.`,
    );
  } else {
    warn(name, `${subAgentId} missing from subagents.json`);
  }
}

function runUnitTests() {
  console.log(`\n${BOLD}${CYAN}Layer 1 — Unit tests${RESET}`);
  const cmd =
    "npx vitest run tests/app-dependent-sync.test.ts tests/jobs-service.test.ts tests/app-agent-chat-sidecar.test.ts tests/sub-agent-metadata-slice.test.ts tests/hydrate-subagents-registry.test.ts -t \"agent chat|subagent|sidecar|metadata\"";
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.status === 0) {
    pass("vitest app-agent job recovery tests");
  } else {
    fail("vitest app-agent job recovery tests", `exit ${result.status}`);
  }
}

function runLocalChecks(paprDir, targetAppId, ctx) {
  console.log(`\n${BOLD}${CYAN}Layer 2 — Local disk${RESET}`);
  console.log(`  papr-home: ${paprDir}`);
  console.log(`  app-id:    ${targetAppId}`);
  console.log(`  job-id:    ${ctx.jobId}`);

  const jobsPath = join(paprDir, "data", "jobs.json");
  const jobJsonPath = join(paprDir, "Jobs", ctx.jobId, "job.json");

  if (!existsSync(jobsPath)) {
    fail("local data/jobs.json exists");
  } else {
    pass("local data/jobs.json exists");
    const localJobs = readJson(jobsPath);
    if (jobInJobsJson(localJobs, ctx.jobId)) {
      pass("local jobs.json contains agentChatJobId");
    } else {
      fail(
        "local jobs.json contains agentChatJobId",
        `${ctx.jobId} missing — restart gateway (JobsService recovery) or re-run enable_app_agent_chat`,
      );
    }
  }

  if (existsSync(jobJsonPath)) {
    pass("local Jobs/{jobId}/job.json exists");
    const jobJson = readJson(jobJsonPath);
    if (jobJson.type === "subagent" && Array.isArray(jobJson.appIds)) {
      pass("local job.json is persistent subagent with appIds");
    } else {
      fail("local job.json shape", JSON.stringify({ type: jobJson.type, appIds: jobJson.appIds }));
    }
    if (jobJson.subAgentId && ctx.subAgentId && jobJson.subAgentId !== ctx.subAgentId) {
      warn(
        "local job subAgentId differs from metadata",
        `job=${jobJson.subAgentId} metadata=${ctx.subAgentId}`,
      );
    }
  } else {
    fail("local Jobs/{jobId}/job.json exists");
  }

  checkSubAgentProfile("local subagents.json contains subAgentId", paprDir, ctx.subAgentId);

  const dirty = gitPorcelain(paprDir, [
    "data/jobs.json",
    "data/subagents.json",
    `Jobs/${ctx.jobId}`,
    `apps/${targetAppId}/metadata.json`,
  ]);
  if (dirty) {
    warn("git has uncommitted app-agent sync files", "run Sync now in Paprwork before testing cloud");
    console.log(`    ${dirty.split("\n").join("\n    ")}`);
  } else {
    pass("git working tree clean for app-agent paths");
  }
}

function runGitHeadChecks(paprDir, targetAppId, ctx) {
  console.log(`\n${BOLD}${CYAN}Layer 3 — Git HEAD (what cloud served after last sync)${RESET}`);

  const headJobsRaw = gitShow(paprDir, "data/jobs.json");
  if (!headJobsRaw) {
    fail("git HEAD data/jobs.json readable");
    return;
  }
  pass("git HEAD data/jobs.json readable");

  const headJobs = JSON.parse(headJobsRaw);
  if (jobInJobsJson(headJobs, ctx.jobId)) {
    pass("git HEAD jobs.json contains agentChatJobId");
  } else {
    fail(
      "git HEAD jobs.json contains agentChatJobId",
      `${ctx.jobId} missing in last pushed sync — cloud will return Job not found until Sync now`,
    );
  }

  const headJobJson = gitShow(paprDir, `Jobs/${ctx.jobId}/job.json`);
  if (headJobJson) {
    pass("git HEAD Jobs/{jobId}/job.json exists");
  } else {
    fail("git HEAD Jobs/{jobId}/job.json exists", "job folder not in cloud git repo");
  }

  const headMetaRaw = gitShow(paprDir, `apps/${targetAppId}/metadata.json`);
  if (!headMetaRaw) {
    fail("git HEAD apps/{appId}/metadata.json readable");
    return;
  }
  const headMeta = JSON.parse(headMetaRaw);
  if (headMeta.agentChatJobId === ctx.jobId) {
    pass("git HEAD metadata.agentChatJobId matches");
  } else {
    fail(
      "git HEAD metadata.agentChatJobId matches",
      `expected ${ctx.jobId}, got ${headMeta.agentChatJobId ?? "null"}`,
    );
  }

  const headSubagentsRaw = gitShow(paprDir, "data/subagents.json");
  if (!headSubagentsRaw) {
    fail("git HEAD data/subagents.json readable");
  } else {
    pass("git HEAD data/subagents.json readable");
    const headSubagents = JSON.parse(headSubagentsRaw);
    const hasProfile =
      Array.isArray(headSubagents) &&
      ctx.subAgentId &&
      headSubagents.some((p) => p?.id === ctx.subAgentId);
    if (hasProfile) {
      pass("git HEAD subagents.json contains subAgentId");
    } else {
      warn(
        "git HEAD subagents.json contains subAgentId",
        `${ctx.subAgentId ?? "null"} missing from namespace git — Mongo registry is authoritative (Phase 4.6)`,
      );
    }
  }
}

async function memorySubagentsIndex() {
  const memoryBase = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
  ).replace(/\/$/, "");
  const res = await fetch(`${memoryBase}/v1/cloud/metadata/subagents`, {
    headers: {
      Accept: "application/json",
      ...(process.env.PAPR_API_KEY ? { "X-API-Key": process.env.PAPR_API_KEY } : {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text, ok: res.ok };
}

async function memoryRepoFile(namespace, appSlug, relativePath) {
  const memoryBase = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
  ).replace(/\/$/, "");
  const res = await fetch(`${memoryBase}/v1/cloud/apps/runtime/repo-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.PAPR_API_KEY ? { "X-API-Key": process.env.PAPR_API_KEY } : {}),
      ...(process.env.PAPR_CLOUD_APP_HOST_KEY
        ? { "X-Cloud-App-Host-Key": process.env.PAPR_CLOUD_APP_HOST_KEY }
        : {}),
    },
    body: JSON.stringify({ namespaceId: namespace, slug: appSlug, relativePath }),
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

async function runLiveCloudChecks(namespace, appSlug, ctx) {
  console.log(`\n${BOLD}${CYAN}Layer 4 — Live cloud repo (memory runtime)${RESET}`);
  if (!process.env.PAPR_API_KEY) {
    warn("live cloud checks skipped", "PAPR_API_KEY not set in .env.local");
    return;
  }

  const metaRes = await memoryRepoFile(namespace, appSlug, "metadata.json");
  if (metaRes.status !== 200 || typeof metaRes.data.content !== "string") {
    fail("cloud metadata.json fetch", `${metaRes.status} ${metaRes.text.slice(0, 200)}`);
    return;
  }
  pass("cloud metadata.json fetch");
  const cloudMeta = JSON.parse(metaRes.data.content);
  if (cloudMeta.agentChatJobId === ctx.jobId) {
    pass("cloud metadata.agentChatJobId matches");
  } else {
    fail("cloud metadata.agentChatJobId matches", cloudMeta.agentChatJobId ?? "null");
  }

  const jobsRes = await memoryRepoFile(namespace, appSlug, "data/jobs.json");
  if (jobsRes.status !== 200 || typeof jobsRes.data.content !== "string") {
    fail("cloud data/jobs.json fetch", `${jobsRes.status} ${jobsRes.text.slice(0, 200)}`);
    return;
  }
  pass("cloud data/jobs.json fetch");
  const cloudJobs = JSON.parse(jobsRes.data.content);
  if (jobInJobsJson(cloudJobs, ctx.jobId)) {
    pass("cloud jobs.json contains agentChatJobId");
  } else {
    fail(
      "cloud jobs.json contains agentChatJobId",
      "Job not found will persist on apps.papr.ai — Sync now + wait for push",
    );
  }

  const jobRes = await memoryRepoFile(
    namespace,
    appSlug,
    `Jobs/${ctx.jobId}/job.json`,
  );
  if (jobRes.status === 200 && typeof jobRes.data.content === "string") {
    pass("cloud Jobs/{jobId}/job.json fetch");
  } else {
    fail("cloud Jobs/{jobId}/job.json fetch", `${jobRes.status}`);
  }

  const subagentsRes = await memorySubagentsIndex();
  if (!subagentsRes.ok || !Array.isArray(subagentsRes.data?.profiles)) {
    fail(
      "cloud Mongo subagents index fetch",
      `${subagentsRes.status} ${subagentsRes.text.slice(0, 200)}`,
    );
  } else {
    pass("cloud Mongo subagents index fetch", `source=${subagentsRes.data.source ?? "unknown"}`);
    const cloudSubagents = subagentsRes.data.profiles;
    const hasProfile =
      ctx.subAgentId && cloudSubagents.some((p) => p?.id === ctx.subAgentId);
    if (hasProfile) {
      pass("cloud Mongo subagents index contains subAgentId");
    } else {
      fail(
        "cloud Mongo subagents index contains subAgentId",
        `${ctx.subAgentId ?? "null"} missing — restart gateway to dual-write profiles, then redeploy memory server if needed`,
      );
    }
  }

  const legacySubagentsRes = await memoryRepoFile(namespace, appSlug, "data/subagents.json");
  if (legacySubagentsRes.status === 200 && typeof legacySubagentsRes.data.content === "string") {
    const cloudSubagents = JSON.parse(legacySubagentsRes.data.content);
    const hasLegacyProfile =
      Array.isArray(cloudSubagents) &&
      ctx.subAgentId &&
      cloudSubagents.some((p) => p?.id === ctx.subAgentId);
    if (hasLegacyProfile) {
      pass("legacy git subagents.json contains subAgentId");
    } else {
      warn(
        "legacy git subagents.json contains subAgentId",
        "missing from namespace git — expected when Sync V3 metadata push is disabled",
      );
    }
  } else {
    warn("legacy git subagents.json fetch", `${legacySubagentsRes.status}`);
  }
}

function runLiveStreamE2E(namespace, appSlug, targetAppId, ctx) {
  console.log(`\n${BOLD}${CYAN}Layer 5 — Live warm + stream E2E${RESET}`);
  const e2eArgs = [
    "scripts/test-app-agent-warm-e2e.mjs",
    `--namespace=${namespace}`,
    `--slug=${appSlug}`,
    `--app-id=${targetAppId}`,
    `--job-id=${ctx.jobId}`,
    "--memory-only",
  ];
  if (ctx.subAgentId) {
    e2eArgs.push(`--sub-agent-id=${ctx.subAgentId}`);
  }
  if (!liveStream) {
    e2eArgs.push("--warm-only");
  }

  const result = spawnSync("node", e2eArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.status === 0) {
    pass("warm/stream E2E script");
  } else {
    fail("warm/stream E2E script", `exit ${result.status}`);
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}App-Agent Chat Deploy Verification${RESET}`);
  console.log("=".repeat(70));

  if (!appId) {
    console.error(`${RED}Pass --app-id=<uuid> (e.g. Deck Studio)${RESET}`);
    process.exit(1);
  }
  if (!existsSync(paprHome)) {
    console.error(`${RED}Papr home not found: ${paprHome}${RESET}`);
    process.exit(1);
  }

  const ctx = resolveAgentChatContext(paprHome, appId);
  if (ctx.error) {
    console.error(`${RED}${ctx.error}${RESET}`);
    process.exit(1);
  }

  if (!skipUnit) {
    runUnitTests();
  }

  runLocalChecks(paprHome, appId, ctx);
  runGitHeadChecks(paprHome, appId, ctx);

  if (liveCloud) {
    if (!namespaceId || !slug) {
      fail("live cloud requires --namespace= and --slug=");
    } else {
      await runLiveCloudChecks(namespaceId, slug, ctx);
    }
  } else {
    warn(
      "live cloud checks skipped",
      "pass --namespace= --slug= --live-cloud to verify memory.papr.ai repo matches git",
    );
  }

  if (liveStream && namespaceId && slug) {
    runLiveStreamE2E(namespaceId, slug, appId, ctx);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${warned} warned${RESET}`,
  );

  if (failed > 0) {
    console.log(`\n${BOLD}Before claiming fixed / shipping:${RESET}`);
    console.log("1. Restart Paprwork gateway (picks up JobsService subagent recovery fix)");
    console.log("2. Confirm local jobs.json contains agentChatJobId (Layer 2 pass)");
    console.log("3. Click Sync now on the app — wait until GitHub sync completes");
    console.log("4. Re-run this script until Layer 3 (git HEAD) passes");
    console.log("5. Run with --live-cloud to confirm memory repo matches");
    console.log("6. Test bubble on apps.papr.ai — should NOT show Job not found");
    process.exit(1);
  }

  console.log(`\n${GREEN}${BOLD}All required checks passed.${RESET} Safe to test on apps.papr.ai.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err.message);
  process.exit(1);
});
