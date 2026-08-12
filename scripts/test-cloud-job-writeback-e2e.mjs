#!/usr/bin/env node
/**
 * E2E: job runtime off git — Mongo + heartbeat + desktop upsert; no git status churn.
 *
 * When JOB_RUNTIME_OFF_GIT=1 on memory server (JOB_RUNTIME_GIT_DUAL_WRITE=0):
 * - Cloud job-run → runtime in Mongo + heartbeat pendingCloudRuns
 * - Desktop upsert → POST /v1/cloud/runtime/job-runtime/upsert + GET list
 * - GitHub data/jobs.json and Jobs/{id}/job.json stay config-only (no lastRunAt/status)
 * - No new "cloud: update job … status" commits on remote
 *
 * Usage:
 *   PAPR_API_KEY=sk-... PAPR_MEMORY_SERVER_URL=http://127.0.0.1:8000 \
 *     node scripts/test-cloud-job-writeback-e2e.mjs
 *
 *   node scripts/test-cloud-job-writeback-e2e.mjs --memory=http://127.0.0.1:8000
 *   node scripts/test-cloud-job-writeback-e2e.mjs --expect-git-writeback
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "https://memory.papr.ai"
).replace(/\/$/, "");

const expectGitWriteback =
  args.includes("--expect-git-writeback") ||
  process.env.JOB_RUNTIME_GIT_DUAL_WRITE === "1" ||
  process.env.JOB_RUNTIME_GIT_DUAL_WRITE === "true";

const runtimeOffGit =
  process.env.JOB_RUNTIME_OFF_GIT === "1" ||
  process.env.JOB_RUNTIME_OFF_GIT === "true" ||
  args.includes("--runtime-off-git") ||
  !expectGitWriteback;

const TEST_JOB_ID = "e2e-cloud-writeback";
const MARKER_PREFIX = "WRITEBACK_E2E_OK";
const DESKTOP_MARKER_PREFIX = "DESKTOP_UPSERT_E2E";

const RUNTIME_FIELD_KEYS = new Set([
  "status",
  "updatedAt",
  "lastRunAt",
  "completedAt",
  "exitCode",
  "error",
  "lastOutput",
  "scheduleState",
  "currentExecutionId",
  "lastExecutionId",
  "currentAttempt",
  "maxAttempts",
  "nextRetryAt",
]);

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

function recordHasRuntimeFields(record) {
  if (!record || typeof record !== "object") return false;
  return [...RUNTIME_FIELD_KEYS].some((key) => record[key] !== undefined);
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

async function githubGetFile({ token, owner, repo, path: filePath }) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
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
    throw new Error(`GitHub GET ${filePath} failed (${res.status})`);
  }
  return res.json();
}

async function githubPutFile({
  token,
  owner,
  repo,
  path: filePath,
  content,
  message,
  sha,
}) {
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
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
    throw new Error(
      `GitHub PUT ${filePath} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res.json();
}

async function githubListCommitsSince({ token, owner, repo, sinceIso }) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("since", sinceIso);
  url.searchParams.set("per_page", "30");
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub commits list failed (${res.status})`);
  }
  return res.json();
}

function parseJobsList(raw) {
  if (!raw?.content) return { jobs: [], sha: raw?.sha ?? null };
  const jobs = JSON.parse(Buffer.from(raw.content, "base64").toString("utf8"));
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs);
  return { jobs: list, sha: raw.sha };
}

function parseGithubJsonFile(raw) {
  if (!raw?.content) return null;
  return JSON.parse(Buffer.from(raw.content, "base64").toString("utf8"));
}

async function ensureTestJob({ token, owner, repo, marker }) {
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
    appIds: ["__standalone__"],
    createdAt: now,
  };
  if (jobIndex >= 0) {
    const prev = jobs[jobIndex];
    jobs[jobIndex] = {
      ...prev,
      ...testJob,
      ...(runtimeOffGit
        ? Object.fromEntries(
            [...RUNTIME_FIELD_KEYS].map((key) => [key, undefined]),
          )
        : {
            status: "idle",
            updatedAt: now,
          }),
    };
    if (runtimeOffGit) {
      for (const key of RUNTIME_FIELD_KEYS) {
        delete jobs[jobIndex][key];
      }
    }
  } else {
    jobs.push(
      runtimeOffGit
        ? testJob
        : { ...testJob, status: "idle", updatedAt: now },
    );
  }

  await githubPutFile({
    token,
    owner,
    repo,
    path: jobsPath,
    content: `${JSON.stringify(jobs, null, 2)}\n`,
    message: "e2e: ensure cloud writeback test job index",
    sha: existing?.sha,
  });

  const jobJsonPath = `Jobs/${TEST_JOB_ID}/job.json`;
  const jobJsonExisting = await githubGetFile({
    token,
    owner,
    repo,
    path: jobJsonPath,
  });
  const configOnlyJob = {
    id: TEST_JOB_ID,
    name: "Cloud Writeback E2E",
    type: "bash",
    command: `echo ${marker}`,
    appIds: ["__standalone__"],
    createdAt: now,
  };
  await githubPutFile({
    token,
    owner,
    repo,
    path: jobJsonPath,
    content: `${JSON.stringify(configOnlyJob, null, 2)}\n`,
    message: "e2e: ensure config-only job.json",
    sha: jobJsonExisting?.sha,
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

async function pollRuntimeSummary(marker, previousLastRunAt, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await findJobSummary();
    if (
      job?.lastRunAt &&
      job.lastRunAt !== previousLastRunAt &&
      (job.lastOutput?.includes(marker) ||
        job.lastOutput?.includes(MARKER_PREFIX) ||
        job.lastOutput?.includes(DESKTOP_MARKER_PREFIX))
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

function assertHeartbeatPatch(patch, marker) {
  if (!patch?.jobId || patch.jobId !== TEST_JOB_ID) {
    fail("heartbeat patch jobId", JSON.stringify(patch).slice(0, 120));
    return false;
  }
  if (!patch.recordedAt) {
    fail("heartbeat patch recordedAt", "missing");
    return false;
  }
  if (!patch.status) {
    fail("heartbeat patch status", "missing");
    return false;
  }
  if (!patch.lastRunAt) {
    fail("heartbeat patch lastRunAt", "missing");
    return false;
  }
  if (
    !patch.lastOutput?.includes(marker) &&
    !patch.lastOutput?.includes(MARKER_PREFIX) &&
    !patch.lastOutput?.includes(DESKTOP_MARKER_PREFIX)
  ) {
    fail(
      "heartbeat patch lastOutput",
      `expected marker in ${patch.lastOutput?.slice(0, 80)}`,
    );
    return false;
  }
  ok(`heartbeat patch status=${patch.status} lastRunAt=${patch.lastRunAt}`);
  return true;
}

async function assertGitHasNoRuntimeChurn({
  token,
  owner,
  repo,
  gitLastRunAtBefore,
  label,
}) {
  const ghAfter = parseJobsList(
    await githubGetFile({ token, owner, repo, path: "data/jobs.json" }),
  );
  const ghJobAfter = ghAfter.jobs.find((j) => j?.id === TEST_JOB_ID);

  if (runtimeOffGit && !expectGitWriteback) {
    if (recordHasRuntimeFields(ghJobAfter)) {
      fail(
        `${label}: jobs.json runtime fields`,
        `found runtime keys on index entry: ${JSON.stringify(ghJobAfter).slice(0, 160)}`,
      );
    } else {
      ok(`${label}: GitHub data/jobs.json is config-only`);
    }

    const gitGainedRuntime =
      ghJobAfter?.lastRunAt &&
      ghJobAfter.lastRunAt !== gitLastRunAtBefore &&
      ghJobAfter?.lastOutput?.includes(MARKER_PREFIX);
    if (gitGainedRuntime) {
      fail(
        `${label}: git runtime churn`,
        "jobs.json gained lastRunAt/lastOutput but JOB_RUNTIME_GIT_DUAL_WRITE is off",
      );
    }

    const perJobRaw = await githubGetFile({
      token,
      owner,
      repo,
      path: `Jobs/${TEST_JOB_ID}/job.json`,
    });
    const perJob = parseGithubJsonFile(perJobRaw);
    if (perJob && recordHasRuntimeFields(perJob)) {
      fail(
        `${label}: Jobs/{id}/job.json runtime fields`,
        JSON.stringify(perJob).slice(0, 160),
      );
    } else if (perJob) {
      ok(`${label}: GitHub Jobs/{id}/job.json is config-only`);
    }
  } else if (ghJobAfter?.lastRunAt && ghJobAfter?.lastOutput?.includes(MARKER_PREFIX)) {
    ok(`${label}: GitHub raw jobs.json confirms dual-write`);
  } else if (expectGitWriteback) {
    fail(
      `${label}: GitHub raw jobs.json`,
      "missing lastRunAt/lastOutput on test job",
    );
  }
}

async function assertNoCloudStatusWritebackCommits({
  token,
  owner,
  repo,
  sinceIso,
  label,
}) {
  if (!runtimeOffGit || expectGitWriteback) {
    return;
  }
  const commits = await githubListCommitsSince({ token, owner, repo, sinceIso });
  const statusCommits = commits.filter((commit) => {
    const msg = commit?.commit?.message ?? "";
    return (
      /cloud:\s*update job/i.test(msg) &&
      (msg.includes(TEST_JOB_ID) || msg.includes("e2e-cloud-writeback"))
    );
  });
  if (statusCommits.length > 0) {
    fail(
      `${label}: no cloud status git commits`,
      statusCommits.map((c) => c.commit.message.split("\n")[0]).join("; "),
    );
  } else {
    ok(`${label}: no new cloud job status writeback commits on GitHub`);
  }
}

function checkLocalPaprGitignore() {
  const paprHome = process.env.PAPR_HOME ?? join(homedir(), "Papr");
  const gitignorePath = join(paprHome, ".gitignore");
  if (!existsSync(gitignorePath)) {
    ok("local ~/Papr/.gitignore not present (cloud sync not initialized yet)");
    return;
  }
  const content = readFileSync(gitignorePath, "utf8");
  if (content.includes("Jobs/*/job.runtime.json") || content.includes("job.runtime.json")) {
    ok("local ~/Papr/.gitignore excludes job.runtime.json");
  } else {
    fail(
      "local ~/Papr/.gitignore",
      "missing Jobs/*/job.runtime.json — runtime could be pushed to git",
    );
  }
  if (content.includes("data/job-runs.jsonl")) {
    ok("local ~/Papr/.gitignore excludes data/job-runs.jsonl");
  } else {
    fail("local ~/Papr/.gitignore", "missing data/job-runs.jsonl");
  }
}

console.log(`\nCloud job runtime E2E → ${memoryBase}`);
console.log(
  `  runtimeOffGit=${runtimeOffGit} expectGitWriteback=${expectGitWriteback}\n`,
);

const testStartedAt = new Date().toISOString();

try {
  checkLocalPaprGitignore();

  const listProbe = await memoryFetch("/v1/cloud/runtime/job-runtime");
  if (listProbe.status === 404) {
    fail(
      "memory server Phase 4 routes",
      "GET /job-runtime returned 404 — restart memory server with latest code",
    );
  } else if (listProbe.status === 200) {
    ok("memory server exposes GET /v1/cloud/runtime/job-runtime");
  } else {
    fail("memory server Phase 4 routes", `${listProbe.status} ${listProbe.text.slice(0, 120)}`);
  }

  const { token, cloneUrl } = await getRepoToken();
  const { owner, repo } = parseOwnerRepo(cloneUrl);
  ok(`repo token (${owner}/${repo})`);

  const ghBefore = parseJobsList(
    await githubGetFile({ token, owner, repo, path: "data/jobs.json" }),
  );
  const ghJobBefore = ghBefore.jobs.find((j) => j?.id === TEST_JOB_ID);
  const gitLastRunAtBefore = ghJobBefore?.lastRunAt ?? null;

  const before = await findJobSummary();
  const previousLastRunAt = before?.lastRunAt ?? null;

  const marker = await ensureTestJob({ token, owner, repo, marker: `${MARKER_PREFIX}_${Date.now()}` });
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

  const updated = await pollRuntimeSummary(marker, previousLastRunAt);
  if (updated) {
    ok(`runtime summary lastRunAt=${updated.lastRunAt}`);
    ok(`runtime summary lastOutput=${(updated.lastOutput ?? "").slice(0, 80)}`);
  } else {
    fail(
      "runtime summary (Mongo/API)",
      "GET /jobs lastRunAt/lastOutput not updated — is JOB_RUNTIME_OFF_GIT=1 on memory server?",
    );
  }

  const heartbeatRes = await memoryFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body: {},
  });
  if (heartbeatRes.status !== 200) {
    fail("heartbeat", `${heartbeatRes.status} ${heartbeatRes.text.slice(0, 200)}`);
  } else {
    ok(`heartbeat desktopAwake=${heartbeatRes.data.desktopAwake}`);
    const pending = heartbeatRes.data.pendingCloudRuns ?? [];
    const patch = pending.find((p) => p?.jobId === TEST_JOB_ID);
    if (patch) {
      assertHeartbeatPatch(patch, marker);
    } else if (pending.length === 0) {
      ok("heartbeat pendingCloudRuns empty (patch may have been drained on prior ping)");
    } else {
      fail(
        "heartbeat pendingCloudRuns",
        `no patch for ${TEST_JOB_ID} in ${pending.length} item(s)`,
      );
    }
  }

  await assertGitHasNoRuntimeChurn({
    token,
    owner,
    repo,
    gitLastRunAtBefore,
    label: "after cloud job-run",
  });
  await assertNoCloudStatusWritebackCommits({
    token,
    owner,
    repo,
    sinceIso: testStartedAt,
    label: "after cloud job-run",
  });

  const desktopMarker = `${DESKTOP_MARKER_PREFIX}_${Date.now()}`;
  const desktopRecordedAt = new Date().toISOString();
  const upsertRes = await memoryFetch("/v1/cloud/runtime/job-runtime/upsert", {
    method: "POST",
    body: {
      jobId: TEST_JOB_ID,
      status: "completed",
      recordedAt: desktopRecordedAt,
      lastRunAt: desktopRecordedAt,
      completedAt: desktopRecordedAt,
      exitCode: 0,
      lastOutput: desktopMarker,
      source: "desktop",
      jobName: "Cloud Writeback E2E",
    },
  });

  if (upsertRes.status !== 200) {
    fail(
      "desktop upsert",
      `${upsertRes.status} ${upsertRes.text.slice(0, 300)}`,
    );
  } else if (upsertRes.data.accepted !== true) {
    fail("desktop upsert accepted", JSON.stringify(upsertRes.data).slice(0, 200));
  } else {
    ok(`desktop upsert accepted recordedAt=${upsertRes.data.recordedAt}`);
  }

  const listRes = await memoryFetch("/v1/cloud/runtime/job-runtime");
  if (listRes.status !== 200) {
    fail("GET job-runtime list", `${listRes.status} ${listRes.text.slice(0, 200)}`);
  } else {
    const patches = listRes.data.patches ?? [];
    const desktopPatch = patches.find(
      (p) => p?.jobId === TEST_JOB_ID && p?.lastOutput?.includes(desktopMarker),
    );
    if (desktopPatch) {
      ok(`GET job-runtime list contains desktop patch (${desktopPatch.status})`);
    } else {
      fail(
        "GET job-runtime list",
        `no patch with ${desktopMarker} among ${patches.length} patch(es)`,
      );
    }
  }

  const desktopSummary = await pollRuntimeSummary(desktopMarker, updated?.lastRunAt ?? previousLastRunAt, 30_000);
  if (desktopSummary?.lastOutput?.includes(desktopMarker)) {
    ok(`runtime summary reflects desktop upsert (${desktopSummary.lastOutput.slice(0, 60)}…)`);
  } else {
    fail(
      "runtime summary after desktop upsert",
      "GET /jobs did not show desktop marker",
    );
  }

  await assertGitHasNoRuntimeChurn({
    token,
    owner,
    repo,
    gitLastRunAtBefore,
    label: "after desktop upsert",
  });
  await assertNoCloudStatusWritebackCommits({
    token,
    owner,
    repo,
    sinceIso: testStartedAt,
    label: "after desktop upsert",
  });
} catch (err) {
  fail("unexpected", err.message);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
