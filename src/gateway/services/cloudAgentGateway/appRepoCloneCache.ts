/**
 * Disk cache for per-app GitHub repo clones used by cloud agent job runs.
 * Cache keys are owner/repo/branch only — commit SHA is tracked separately so
 * publish can bust stale snapshots without waiting for Cloud Run recycle.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AppRepoCommittedEvent } from "../syncV3/appRepoCommittedFanout.js";

const execFileAsync = promisify(execFile);

export const REPO_CACHE_DIR = path.join(os.tmpdir(), "papr-cloud-repo-cache");
export const MATERIALIZED_HEAD_FILE = ".papr-materialized-head";
const CACHE_HEAD_FILE = ".papr-cache-head";

export function appRepoCacheKey(owner: string, repo: string, branch: string): string {
  return crypto
    .createHash("sha256")
    .update(`${branch}\0${owner}/${repo}`)
    .digest("hex")
    .slice(0, 24);
}

export function appRepoCachePath(owner: string, repo: string, branch: string): string {
  return path.join(REPO_CACHE_DIR, `app-${appRepoCacheKey(owner, repo, branch)}`);
}

function injectTokenIntoCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${encodeURIComponent(token)}@${normalized}`;
}

/** Resolve branch tip SHA via git ls-remote (cheap HEAD check before using disk cache). */
export async function resolveRemoteHeadSha(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<string | null> {
  const branch = input.branch.trim() || "main";
  const url = injectTokenIntoCloneUrl(
    `https://github.com/${input.owner}/${input.repo}.git`,
    input.token,
  );
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", url, `refs/heads/${branch}`],
      { timeout: 30_000 },
    );
    const sha = stdout.trim().split(/\s+/)[0]?.trim();
    return sha && sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

export async function readMaterializedHeadSha(paprHome: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(paprHome, MATERIALIZED_HEAD_FILE),
      "utf8",
    );
    const sha = raw.trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

export async function writeMaterializedHeadSha(
  paprHome: string,
  commitSha: string,
): Promise<void> {
  await fs.mkdir(paprHome, { recursive: true });
  await fs.writeFile(
    path.join(paprHome, MATERIALIZED_HEAD_FILE),
    `${commitSha}\n`,
    "utf8",
  );
}

async function readCacheHeadSha(cachePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(cachePath, CACHE_HEAD_FILE), "utf8");
    const sha = raw.trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

export async function writeCacheHeadSha(
  cachePath: string,
  commitSha: string,
): Promise<void> {
  await fs.mkdir(cachePath, { recursive: true });
  await fs.writeFile(path.join(cachePath, CACHE_HEAD_FILE), `${commitSha}\n`, "utf8");
}

/** True when disk cache exists and matches remote HEAD. */
export async function isAppRepoDiskCacheFresh(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<{ fresh: boolean; cachePath: string; remoteHead: string | null }> {
  const branch = input.branch.trim() || "main";
  const cachePath = appRepoCachePath(input.owner, input.repo, branch);
  const remoteHead = await resolveRemoteHeadSha(input);
  if (!remoteHead) {
    return { fresh: false, cachePath, remoteHead };
  }

  try {
    await fs.access(cachePath);
  } catch {
    return { fresh: false, cachePath, remoteHead };
  }

  const cachedHead = await readCacheHeadSha(cachePath);
  return {
    fresh: cachedHead === remoteHead,
    cachePath,
    remoteHead,
  };
}

/** Warm workspace is reusable only when its materialized HEAD matches remote. */
export async function isWarmWorkspaceFresh(input: {
  paprHome: string;
  owner: string;
  repo: string;
  branch?: string;
  token: string;
}): Promise<boolean> {
  const materializedHead = await readMaterializedHeadSha(input.paprHome);
  if (!materializedHead) {
    return false;
  }
  const remoteHead = await resolveRemoteHeadSha({
    owner: input.owner,
    repo: input.repo,
    branch: input.branch ?? "main",
    token: input.token,
  });
  return remoteHead !== null && materializedHead === remoteHead;
}

export async function invalidateAppRepoCloneCache(input: {
  owner: string;
  repo: string;
  branch?: string;
}): Promise<boolean> {
  const branch = input.branch?.trim() || "main";
  const cachePath = appRepoCachePath(input.owner, input.repo, branch);
  try {
    await fs.access(cachePath);
  } catch {
    return false;
  }
  await fs.rm(cachePath, { recursive: true, force: true });
  console.log(
    `[CloudAgentClone] Invalidated repo disk cache ${input.owner}/${input.repo}@${branch}`,
  );
  return true;
}

export async function invalidateAppRepoCloneCacheForEvent(
  event: AppRepoCommittedEvent,
): Promise<boolean> {
  return invalidateAppRepoCloneCache({
    owner: event.githubOrg,
    repo: event.repoName,
  });
}
