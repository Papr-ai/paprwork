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
): Promise<{ content: string; contentType: string } | null> {
  const objectPath = resolveGithubRepoObjectPath(credentials, relativePath);
  const branch = credentials.defaultBranch.trim() || "main";
  const url =
    `https://raw.githubusercontent.com/${credentials.githubOrg}/` +
    `${credentials.repoName}/${branch}/${objectPath}`;

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
