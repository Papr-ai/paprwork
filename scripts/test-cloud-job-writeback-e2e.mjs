#!/usr/bin/env node
/**
 * E2E: cloud job-run git writeback + Turso boundary (live GitHub).
 *
 * Ensures a bash test job exists in the user's Papr cloud repo, runs it via
 * POST /v1/cloud/runtime/job-run, then verifies jobs.json was updated on GitHub.
 *
 * Usage:
 *   PAPR_API_KEY=sk-... node scripts/test-cloud-job-writeback-e2e.mjs
 *   node scripts/test-cloud-job-writeback-e2e.mjs --memory=https://memory.papr.ai
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "https://memory.papr.ai"
).replace(/\/$/, "");

const TEST_JOB_ID = "e2e-cloud-writeback";
const MARKER_PREFIX = "WRITEBACK_E2E_OK";

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

async function memoryFetch(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${memoryBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
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
  };
}

function parseOwnerRepo(cloneUrl) {
  const path = cloneUrl.replace("https://github.com/", "").replace(".git", "");
  const [owner, repo] = path.split("/");
  return { owner, repo };
}

async function githubGetFile({ token, owner, repo, path }) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed (${res.status})`);
  }
  return res.json();
}

async function githubPutFile({ token, owner, repo, path, content, message, sha }) {
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function ensureTestJob({ token, owner, repo }) {
  const marker = `${MARKER_PREFIX}_${Date.now()}`;
  const jobsPath = "data/jobs.json";
  const existing = await githubGetFile({ token, owner, repo, path: jobsPath });
  let jobs = [];
  if (existing?.content) {
    jobs = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
    if (!Array.isArray(jobs)) jobs = Object.values(jobs);
  }

  const now = new Date().toISOString();
  const jobIndex = jobs.findIndex((j) => j?.id === TEST_JOB_ID);
  const testJob = {
    id: TEST_JOB_ID,
    name: "Cloud Writeback E2E",
    type: "bash",
    command: `echo ${marker}`,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  if (jobIndex >= 0) {
    jobs[jobIndex] = { ...jobs[jobIndex], ...testJob };
  } else {
    jobs.push(testJob);
  }

  await githubPutFile({
    token,
    owner,
    repo,
    path: jobsPath,
    content: `${JSON.stringify(jobs, null, 2)}\n`,
    message: "e2e: ensure cloud writeback test job",
    sha: existing?.sha,
  });

  const jobDirPath = `Jobs/${TEST_JOB_ID}/README.md`;
  const dirFile = await githubGetFile({ token, owner, repo, path: jobDirPath });
  if (!dirFile) {
    await githubPutFile({
      token,
      owner,
      repo,
      path: jobDirPath,
      content: "# Cloud writeback E2E job workspace\n",
      message: "e2e: add writeback test job workspace",
    });
  }

  await new Promise((r) => setTimeout(r, 3000));
  return marker;
}

async function findJobSummary() {
  const res = await memoryFetch("/v1/cloud/runtime/jobs");
  if (res.status !== 200) {
    throw new Error(`jobs list failed (${res.status})`);
  }
  return res.data.jobs?.find((j) => j.id === TEST_JOB_ID) ?? null;
}

async function pollWriteback(marker, previousLastRunAt, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await findJobSummary();
    if (
      job?.lastRunAt &&
      job.lastRunAt !== previousLastRunAt &&
      (job.lastOutput?.includes(marker) || job.lastOutput?.includes(MARKER_PREFIX))
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

console.log(`\nCloud job writeback E2E → ${memoryBase}\n`);

try {
  const { token, cloneUrl } = await getRepoToken();
  const { owner, repo } = parseOwnerRepo(cloneUrl);
  ok(`repo token (${owner}/${repo})`);

  const before = await findJobSummary();
  const previousLastRunAt = before?.lastRunAt ?? null;

  const marker = await ensureTestJob({ token, owner, repo });
  ok(`test job synced (${TEST_JOB_ID})`);

  const runRes = await memoryFetch("/v1/cloud/runtime/job-run", {
    method: "POST",
    body: {
      jobId: TEST_JOB_ID,
      tier: "sandbox",
      timeoutMs: 120_000,
    },
  });

  if (runRes.status !== 200) {
    fail("job-run", `${runRes.status} ${runRes.text.slice(0, 300)}`);
  } else {
    ok(`job-run exitCode=${runRes.data.exitCode} backend=${runRes.data.backend}`);
    if (runRes.data.stdout?.includes(marker) || runRes.data.lastOutput?.includes(marker)) {
      ok("job-run output contains marker");
    } else {
      fail("job-run output", `expected ${marker} in stdout/lastOutput`);
    }
  }

  const updated = await pollWriteback(marker, previousLastRunAt);
  if (updated) {
    ok(`GitHub writeback lastRunAt=${updated.lastRunAt}`);
    ok(`GitHub writeback lastOutput=${(updated.lastOutput ?? "").slice(0, 80)}`);
  } else {
    fail(
      "GitHub writeback",
      "jobs.json lastRunAt/lastOutput not updated within timeout — deploy latest memory server",
    );
  }

  const ghJobs = await githubGetFile({ token, owner, repo, path: "data/jobs.json" });
  if (ghJobs?.content) {
    const parsed = JSON.parse(Buffer.from(ghJobs.content, "base64").toString("utf8"));
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const ghJob = list.find((j) => j?.id === TEST_JOB_ID);
    if (ghJob?.lastRunAt && ghJob?.lastOutput?.includes(MARKER_PREFIX)) {
      ok("GitHub raw jobs.json confirms writeback");
    } else {
      fail("GitHub raw jobs.json", "missing lastRunAt/lastOutput on test job");
    }
  }
} catch (err) {
  fail("unexpected", err.message);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
