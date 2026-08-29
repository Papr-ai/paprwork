import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_CACHE_DIR = path.join(os.tmpdir(), "papr-cloud-repo-cache");

function repoCacheKey(cloneUrl: string, branch: string): string {
  return crypto
    .createHash("sha256")
    .update(`${branch}\0${cloneUrl}`)
    .digest("hex")
    .slice(0, 24);
}

export async function cloneUserRepoToPaprHome(input: {
  targetPaprHome: string;
  cloneUrl: string;
  token: string;
  branch?: string;
}): Promise<void> {
  const branch = input.branch ?? "main";
  const cacheKey = repoCacheKey(input.cloneUrl, branch);
  const cachePath = path.join(REPO_CACHE_DIR, cacheKey);

  await fs.rm(input.targetPaprHome, { recursive: true, force: true });
  await fs.mkdir(path.dirname(input.targetPaprHome), { recursive: true });

  try {
    await fs.access(cachePath);
    await fs.cp(cachePath, input.targetPaprHome, { recursive: true });
    console.log(`[CloudAgentClone] Restored workspace from disk cache (${cacheKey})`);
    return;
  } catch {
    /* cache miss — fall through to git clone */
  }

  const url = injectTokenIntoCloneUrl(input.cloneUrl, input.token);
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, url, input.targetPaprHome],
    { timeout: 180_000 },
  );

  await fs.mkdir(REPO_CACHE_DIR, { recursive: true });
  await fs.rm(cachePath, { recursive: true, force: true }).catch(() => undefined);
  await fs.cp(input.targetPaprHome, cachePath, { recursive: true });
  console.log(`[CloudAgentClone] Populated disk cache (${cacheKey})`);
}

function injectTokenIntoCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${encodeURIComponent(token)}@${normalized}`;
}

function appRepoCacheKey(owner: string, repo: string, branch: string): string {
  return crypto
    .createHash("sha256")
    .update(`${branch}\0${owner}/${repo}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Materialize a Sync V3 per-app repo into a minimal Papr workspace:
 *   apps/{appId}/  ← app repo root
 *   Jobs/{jobId}/  ← jobs/{jobId}/ from app repo when present
 *   data/*         ← scaffoldFiles from memory (jobs.json, apps.json, …)
 */
export async function materializeAppWorkspaceToPaprHome(input: {
  targetPaprHome: string;
  appId: string;
  jobId: string;
  owner: string;
  repo: string;
  token: string;
  branch?: string;
  scaffoldFiles?: Record<string, string>;
}): Promise<void> {
  const branch = input.branch ?? "main";
  const cacheKey = appRepoCacheKey(input.owner, input.repo, branch);
  const cachePath = path.join(REPO_CACHE_DIR, `app-${cacheKey}`);
  const appDest = path.join(input.targetPaprHome, "apps", input.appId);

  await fs.rm(input.targetPaprHome, { recursive: true, force: true });
  await fs.mkdir(appDest, { recursive: true });

  let repoRoot = cachePath;
  try {
    await fs.access(cachePath);
    console.log(
      `[CloudAgentClone] Using cached app repo ${input.owner}/${input.repo} (${cacheKey})`,
    );
  } catch {
    repoRoot = path.join(
      os.tmpdir(),
      `papr-app-clone-${cacheKey}-${Date.now()}`,
    );
    const cloneUrl = `https://github.com/${input.owner}/${input.repo}.git`;
    const url = injectTokenIntoCloneUrl(cloneUrl, input.token);
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", branch, url, repoRoot],
      { timeout: 180_000 },
    );
    await fs.mkdir(REPO_CACHE_DIR, { recursive: true });
    await fs.rm(cachePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(repoRoot, cachePath, { recursive: true });
    console.log(
      `[CloudAgentClone] Cached app repo ${input.owner}/${input.repo} (${cacheKey})`,
    );
    repoRoot = cachePath;
  }

  const repoEntries = await fs.readdir(repoRoot, { withFileTypes: true });
  for (const entry of repoEntries) {
    if (entry.name === ".git") {
      continue;
    }
    await fs.cp(
      path.join(repoRoot, entry.name),
      path.join(appDest, entry.name),
      { recursive: true },
    );
  }

  const appJobsPrefix = path.join(repoRoot, "jobs", input.jobId);
  const legacyJobDest = path.join(input.targetPaprHome, "Jobs", input.jobId);
  try {
    await fs.access(appJobsPrefix);
    await fs.mkdir(path.dirname(legacyJobDest), { recursive: true });
    await fs.cp(appJobsPrefix, legacyJobDest, { recursive: true });
  } catch {
    /* agent jobs may not have a jobs/{id} folder in the app repo */
  }

  if (input.scaffoldFiles) {
    for (const [relativePath, contents] of Object.entries(input.scaffoldFiles)) {
      const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized || normalized.includes("..")) {
        continue;
      }
      const dest = path.join(input.targetPaprHome, normalized);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, contents, "utf8");
    }
  }

  console.log(
    `[CloudAgentClone] Materialized app workspace appId=${input.appId} ` +
      `repo=${input.owner}/${input.repo} → ${input.targetPaprHome}`,
  );
}
