/**
 * Fetch published app files directly from GitHub using credentials from
 * runtime/repo-credentials.
 */

import { getMiniAppContentType } from "../../utils/miniAppStaticAssets.js";
import type { AppRuntimeRepoCredentials } from "./types.js";

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  return normalized;
}

/** Map repoPath ("." or "apps/{appId}") + file path to GitHub object path. */
export function resolveGithubRepoObjectPath(
  credentials: AppRuntimeRepoCredentials,
  relativePath: string,
): string {
  const safe = normalizeRelativePath(relativePath);
  const prefix = credentials.repoPath.trim().replace(/\/+$/, "");
  if (!prefix || prefix === ".") {
    return safe;
  }
  return `${prefix}/${safe}`;
}

export async function fetchGithubRepoTextFile(
  credentials: AppRuntimeRepoCredentials,
  relativePath: string,
  timeoutMs = 30_000,
  /** Commit SHA to read at. Branch-name reads are CDN-cached (~5 min stale); SHA reads never are. */
  ref?: string,
): Promise<{ content: string; contentType: string } | null> {
  const objectPath = resolveGithubRepoObjectPath(credentials, relativePath);
  const branch = credentials.defaultBranch.trim() || "main";
  const url =
    `https://raw.githubusercontent.com/${credentials.githubOrg}/` +
    `${credentials.repoName}/${ref?.trim() || branch}/${objectPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${credentials.token}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "papr-cloud-app-host",
      },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `GitHub fetch failed (${res.status}) for ${objectPath}`,
      );
    }
    const content = await res.text();
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() ??
      getMiniAppContentType(relativePath);
    return { content, contentType };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`GitHub fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** TTL for cached credentials — refresh 5 minutes before GitHub token expiry. */
export function repoCredentialsCacheTtlMs(expiresAtIso: string): number {
  const expiresMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresMs)) {
    return 3_600_000;
  }
  const bufferMs = 5 * 60 * 1000;
  const ttl = expiresMs - Date.now() - bufferMs;
  return Math.max(ttl, 60_000);
}

/** GitHub said the installation's API budget is gone; don't ask again before `resetAt`. */
export class GithubRateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt: number,
  ) {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

export type GithubBranchHeadResult =
  | { notModified: false; sha: string; etag?: string }
  | { notModified: true };

/** Wait until GitHub's budget resets; null if this response is not a rate limit. */
function rateLimitResetAt(res: Response, now: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");
  if (remaining !== "0" && !retryAfter) return null;
  if (retryAfter && /^\d+$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(now, Number(reset) * 1000);
  return now + 60_000;
}

/**
 * Current commit SHA of the default branch via the GitHub API (not the raw CDN),
 * so file reads can be pinned to an immutable ref.
 *
 * Pass the ETag from the previous answer: if the branch hasn't moved GitHub
 * replies 304, which does not count against the rate limit.
 */
export async function fetchGithubBranchHead(
  credentials: AppRuntimeRepoCredentials,
  options: { etag?: string; timeoutMs?: number } = {},
): Promise<GithubBranchHeadResult> {
  const branch = credentials.defaultBranch.trim() || "main";
  const url =
    `https://api.github.com/repos/${credentials.githubOrg}/` +
    `${credentials.repoName}/commits/${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = {
    Authorization: `token ${credentials.token}`,
    Accept: "application/vnd.github.sha",
    "User-Agent": "papr-cloud-app-host",
  };
  if (options.etag) {
    headers["If-None-Match"] = options.etag;
  }
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (res.status === 304 && options.etag) {
    return { notModified: true };
  }
  if (!res.ok) {
    // Diagnostics: same token reads files fine but /commits returns 403 from Cloud Run.
    // Log why (rate limit vs IP allow list vs permissions) — body + GitHub headers.
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const h = (name: string) => res.headers.get(name) ?? "-";
    const message =
      `GitHub head lookup failed (${res.status}) for ${credentials.repoName}: ${body} ` +
      `[remaining=${h("x-ratelimit-remaining")} resource=${h("x-ratelimit-resource")} ` +
      `accepted=${h("x-accepted-github-permissions")} sso=${h("x-github-sso")} req=${h("x-github-request-id")}]`;
    const resetAt = rateLimitResetAt(res, Date.now());
    if (resetAt !== null) {
      throw new GithubRateLimitError(message, resetAt);
    }
    throw new Error(message);
  }
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub head lookup returned no SHA for ${credentials.repoName}`);
  }
  return { notModified: false, sha, etag: res.headers.get("etag") ?? undefined };
}

/** Back-compat wrapper: always a full (non-conditional) lookup. */
export async function fetchGithubBranchHeadSha(
  credentials: AppRuntimeRepoCredentials,
  timeoutMs = 10_000,
): Promise<string> {
  const result = await fetchGithubBranchHead(credentials, { timeoutMs });
  if (result.notModified) {
    throw new Error("unreachable: 304 without an ETag");
  }
  return result.sha;
}
