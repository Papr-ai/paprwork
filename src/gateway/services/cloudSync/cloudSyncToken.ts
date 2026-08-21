/**
 * Cloud repo token fetch + git identity helpers (namespace git pull path).
 */

import * as fs from "fs";
import * as path from "path";
import { buildCloudReposRequestBody } from "../../../core/utils/cloudReposScope.js";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import type { GitRunner } from "./gitRunner.js";
import type { RunGitFn } from "./gitStageScope.js";

export interface RepoTokenResponse {
  repos: Array<{ scope: string; repoUrl: string; cloneUrl: string }>;
  token: string;
  expiresAt: string;
}

export interface TokenCache {
  token: string;
  expiresAt: Date;
  cloneUrl: string;
}

export interface TokenStateCallbacks {
  getRepoUrl: () => string | null;
  setRepoUrl: (url: string) => void;
  getTokenCache: () => TokenCache | null;
  setTokenCache: (cache: TokenCache | null) => void;
}

export function normalizeRepoIdentity(url: string): string {
  return url
    .replace(/x-access-token:[^@]+@/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export function buildAuthedUrl(cloneUrl: string, token: string): string {
  if (cloneUrl.includes("x-access-token:")) {
    return cloneUrl.replace(/x-access-token:[^@]+/, `x-access-token:${token}`);
  }
  return cloneUrl.replace("https://", `https://x-access-token:${token}@`);
}

export function hasWorkspaceGitAtRoot(paprDir: string): boolean {
  return fs.existsSync(path.join(paprDir, ".git"));
}

/** Parent git root when workspace has no local `.git` but inherits ancestor repo. */
export async function getForeignGitRoot(
  paprDir: string,
  gitRunner: GitRunner,
  git: RunGitFn,
): Promise<string | null> {
  if (hasWorkspaceGitAtRoot(paprDir)) {
    return null;
  }
  if (!(await gitRunner.isRepo(paprDir))) {
    return null;
  }
  try {
    const topLevel = (await git(["rev-parse", "--show-toplevel"])).trim();
    const resolved = path.resolve(topLevel);
    if (resolved !== path.resolve(paprDir)) {
      return resolved;
    }
  } catch {
    /* not in a git work tree */
  }
  return null;
}

export async function getOriginRepoIdentity(git: RunGitFn): Promise<string | null> {
  try {
    const remote = await git(["remote", "get-url", "origin"]);
    return normalizeRepoIdentity(remote);
  } catch {
    return null;
  }
}

export async function callReposInit(state: TokenStateCallbacks): Promise<boolean> {
  try {
    const resp = await cloudApiFetch("/v1/cloud/repos/init", {
      method: "POST",
      body: buildCloudReposRequestBody("user"),
      timeoutMs: 60_000,
    });
    if (!resp.ok) {
      console.warn("[CloudSync] repos/init failed:", resp.status);
      return false;
    }
    const data = (await resp.json()) as { repoUrl?: string };
    if (data.repoUrl) {
      state.setRepoUrl(data.repoUrl);
    }
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("AbortError") || msg.includes("aborted")) {
      console.warn("[CloudSync] repos/init timed out (non-fatal, will retry on next sync)");
    } else {
      console.warn("[CloudSync] repos/init error:", msg.slice(0, 100));
    }
    return false;
  }
}

export async function fetchRepoToken(
  state: TokenStateCallbacks,
): Promise<RepoTokenResponse | null> {
  try {
    const resp = await cloudApiFetch("/v1/cloud/repos/token", {
      method: "POST",
      body: buildCloudReposRequestBody("user"),
      timeoutMs: 60_000,
    });
    if (resp.status === 401) return null;
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`repos/token ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as RepoTokenResponse;
    const userRepo = data.repos.find((r) => r.scope === "user") ?? data.repos[0];
    if (!userRepo?.cloneUrl) {
      throw new Error("repos/token missing user cloneUrl");
    }
    applyUserRepoToken(state, userRepo, data.token, data.expiresAt);
    return data;
  } catch (err) {
    console.error("[CloudSync] Token fetch failed:", (err as Error).message);
    return null;
  }
}

export async function ensureFreshToken(state: TokenStateCallbacks): Promise<string | null> {
  const bufferMs = 5 * 60_000;
  const cache = state.getTokenCache();
  if (cache && cache.expiresAt.getTime() - Date.now() > bufferMs) {
    return cache.token;
  }
  const resp = await fetchRepoToken(state);
  return resp?.token ?? null;
}

export function applyUserRepoToken(
  state: TokenStateCallbacks,
  userRepo: { repoUrl: string; cloneUrl: string },
  token: string,
  expiresAt: string,
): void {
  state.setRepoUrl(userRepo.repoUrl);
  state.setTokenCache({
    token,
    expiresAt: new Date(expiresAt),
    cloneUrl: userRepo.cloneUrl,
  });
}
