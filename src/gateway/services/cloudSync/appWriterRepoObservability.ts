/**
 * Canonical per-app writer repo observability — avoids the legacy namespace git trap.
 */

import { NAMESPACE_GIT_TRAP_WARNING } from "../../../core/utils/namespaceGitTrapGuard.js";
import type { AppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import { getCachedAppRepoRecord } from "../syncV3/appRepoRegistryCache.js";
import { fetchAppRepoReadCredentials } from "../syncV3/AppRepoClient.js";
import { readAppRepoCommitCursors } from "../syncV3/appRepoCommittedFanout.js";
import {
  buildAppSyncV3Report,
  type AppSyncV3Report,
} from "../syncV3/appSyncV3StatusReport.js";
import * as fs from "node:fs";
import * as path from "node:path";

import type { GitHubSyncItemsReport } from "./syncItemStatus.js";
import type { SyncStateManager } from "./syncState.js";
import type { getCloudSyncService } from "../CloudSyncService.js";

export interface WorkspaceAppRegistryEntry {
  id: string;
  title: string;
  /** Local source folder — accurate for what exists on disk. */
  localPath: string;
}

interface AppIndexEntry {
  id?: string;
  title?: string;
}

export function loadWorkspaceAppRegistry(paprDir: string): WorkspaceAppRegistryEntry[] {
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const apps = JSON.parse(raw) as AppIndexEntry[] | Record<string, AppIndexEntry>;
    const list = Array.isArray(apps) ? apps : Object.values(apps);
    return list
      .filter((entry): entry is AppIndexEntry & { id: string } => Boolean(entry.id))
      .map((entry) => ({
        id: entry.id,
        title: entry.title?.trim() || entry.id.slice(0, 8),
        localPath: `apps/${entry.id}/`,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  } catch {
    return [];
  }
}

function summarizeGitHubItems(
  items: Array<{ status: string }>,
): GitHubSyncItemsReport["summary"] {
  let synced = 0;
  let pending = 0;
  let outdated = 0;
  let failed = 0;
  let updatesAvailable = 0;
  for (const item of items) {
    if (item.status === "synced") synced += 1;
    else if (item.status === "pending") pending += 1;
    else if (item.status === "outdated") outdated += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "updates_available") updatesAvailable += 1;
  }
  return {
    synced,
    pending,
    outdated,
    failed,
    updatesAvailable,
    total: items.length,
  };
}

/** Agent-facing github report — omits misleading legacy apps/ sync rows. */
export function sanitizeGitHubReportForAgents(
  report: GitHubSyncItemsReport,
): GitHubSyncItemsReport & {
  appsOmitted: true;
  appsOmittedReason: string;
} {
  const nonAppItems = [...report.workspace, ...report.jobs];
  return {
    ...report,
    apps: [],
    appsOmitted: true,
    appsOmittedReason:
      "apps/ namespace sync rows hidden — Sync V3 app code uses per-app writer repos. " +
      "Use workspaceApps (local apps.json) to list apps; get_cloud_sync_status({ appId }) → appWriterRepo or inspect_cloud_repo({ appId }) for cloud code.",
    summary: summarizeGitHubItems(nonAppItems),
  };
}

export { NAMESPACE_GIT_TRAP_WARNING };

const APP_ID_IN_PATH_RE =
  /^apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export interface AppWriterRepoReport {
  sourceOfTruth: "per-app-writer-repo";
  appId: string;
  namespaceGitTrapWarning: string;
  repo: {
    cloneUrl: string;
    repoUrl: string;
    githubOrg: string;
    repoName: string;
  } | null;
  lastCommit: {
    sha: string;
    updatedAt: string;
  } | null;
  syncV3: AppSyncV3Report;
  pathGuide: {
    localAppDir: string;
    cloudRepoRoot: string;
    legacyNamespacePath: string;
    note: string;
  };
}

export interface GitHubOwnerRepo {
  owner: string;
  repo: string;
}

export function parseGitHubOwnerRepo(cloneUrl: string): GitHubOwnerRepo {
  const pathPart = cloneUrl
    .replace(/^https:\/\/x-access-token:[^@]+@github\.com\//i, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  const [owner, repo] = pathPart.split("/");
  if (!owner || !repo) {
    throw new Error(`Could not parse GitHub owner/repo from clone URL: ${cloneUrl}`);
  }
  return { owner, repo };
}

/** Strip legacy namespace prefix apps/{appId}/ so paths match per-app repo root. */
export function normalizePerAppRepoRelativePath(
  relativePath: string,
  appId?: string,
): { path: string; inferredAppId?: string } {
  const trimmed = relativePath.trim().replace(/^\/+/, "");
  const match = trimmed.match(APP_ID_IN_PATH_RE);
  if (match) {
    const inferredAppId = match[1];
    const rest = trimmed.slice(`apps/${inferredAppId}/`.length);
    if (appId && inferredAppId.toLowerCase() !== appId.toLowerCase()) {
      throw new Error(
        `relativePath is for app ${inferredAppId} but appId is ${appId}. Pass one app only.`,
      );
    }
    return { path: rest, inferredAppId };
  }
  return { path: trimmed, inferredAppId: appId };
}

export function extractAppIdFromRepoPath(relativePath: string): string | null {
  const trimmed = relativePath.trim().replace(/^\/+/, "");
  const match = trimmed.match(APP_ID_IN_PATH_RE);
  return match?.[1] ?? null;
}

function toRepoSummary(record: AppRepoRecord): AppWriterRepoReport["repo"] {
  return {
    cloneUrl: record.cloneUrl,
    repoUrl: record.repoUrl,
    githubOrg: record.githubOrg,
    repoName: record.repoName,
  };
}

export async function buildAppWriterRepoReport(input: {
  appId: string;
  paprDir: string;
  stateManager: SyncStateManager;
  queuedPaths?: readonly string[];
}): Promise<AppWriterRepoReport> {
  const appId = input.appId.trim();
  const cached = await getCachedAppRepoRecord(appId);
  const cursors = await readAppRepoCommitCursors();
  const cursor = cursors[appId] ?? null;

  const syncV3 = await buildAppSyncV3Report({
    appId,
    paprDir: input.paprDir,
    stateManager: input.stateManager,
    queuedPaths: input.queuedPaths,
  });

  return {
    sourceOfTruth: "per-app-writer-repo",
    appId,
    namespaceGitTrapWarning: NAMESPACE_GIT_TRAP_WARNING,
    repo: cached ? toRepoSummary(cached) : null,
    lastCommit: cursor
      ? { sha: cursor.lastCommitSha, updatedAt: cursor.updatedAt }
      : null,
    syncV3,
    pathGuide: {
      localAppDir: `apps/${appId}/`,
      cloudRepoRoot: ".",
      legacyNamespacePath: `apps/${appId}/`,
      note:
        "Cloud app files (dist/, backend/, metadata.json) live at the per-app repo root — not under apps/{id}/ in that repo.",
    },
  };
}

async function githubHeaders(token: string): Promise<Record<string, string>> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function resolvePerAppCommitSha(
  appId: string,
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const cursors = await readAppRepoCommitCursors();
  const cached = cursors[appId]?.lastCommitSha?.trim();
  if (cached) {
    return cached;
  }
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`, {
    headers: await githubHeaders(token),
  });
  if (!resp.ok) {
    throw new Error(
      `Per-app repo commit lookup failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
    );
  }
  const payload = (await resp.json()) as { sha?: string };
  if (!payload.sha) {
    throw new Error("Per-app repo commit lookup returned no sha.");
  }
  return payload.sha;
}

export async function readPerAppRepoFile(input: {
  appId: string;
  relativePath: string;
}): Promise<{ relativePath: string; content: string; source: "per-app-github" }> {
  const appId = input.appId.trim();
  const normalized = normalizePerAppRepoRelativePath(input.relativePath, appId);
  if (!normalized.path) {
    throw new Error("relativePath must name a file inside the per-app repo.");
  }

  const creds = await fetchAppRepoReadCredentials(appId);
  if (!creds) {
    throw new Error(
      `Per-app repo read credentials unavailable for ${appId}. Run get_cloud_sync_status({ appId }) first.`,
    );
  }

  const { owner, repo } = parseGitHubOwnerRepo(creds.cloneUrl);
  const encodedPath = normalized.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`,
    { headers: await githubHeaders(creds.token) },
  );
  if (response.status === 404) {
    throw new Error(`Per-app repo file not found: ${normalized.path} (app ${appId})`);
  }
  if (!response.ok) {
    throw new Error(
      `Per-app repo file fetch failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (!payload.content || payload.encoding !== "base64") {
    throw new Error(`GitHub returned non-file content for ${normalized.path}`);
  }
  return {
    relativePath: normalized.path,
    content: Buffer.from(payload.content, "base64").toString("utf8"),
    source: "per-app-github",
  };
}

export async function listPerAppRepoFiles(input: {
  appId: string;
  prefix?: string;
  maxFiles?: number;
}): Promise<{
  appId: string;
  prefix: string;
  files: string[];
  source: "per-app-github-tree";
  commitSha: string;
}> {
  const appId = input.appId.trim();
  const prefix = (input.prefix ?? "").trim().replace(/^\/+/, "");
  const maxFiles = Math.min(Math.max(1, input.maxFiles ?? 200), 500);

  const creds = await fetchAppRepoReadCredentials(appId);
  if (!creds) {
    throw new Error(
      `Per-app repo read credentials unavailable for ${appId}. Run get_cloud_sync_status({ appId }) first.`,
    );
  }

  const { owner, repo } = parseGitHubOwnerRepo(creds.cloneUrl);
  const commitSha = await resolvePerAppCommitSha(appId, owner, repo, creds.token);
  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    { headers: await githubHeaders(creds.token) },
  );
  if (!treeResp.ok) {
    throw new Error(
      `Per-app repo tree listing failed (${treeResp.status}): ${(await treeResp.text()).slice(0, 200)}`,
    );
  }
  const treePayload = (await treeResp.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const files =
    treePayload.tree
      ?.filter((entry) => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path as string)
      .filter((filePath) => !prefix || filePath.startsWith(prefix))
      .slice(0, maxFiles) ?? [];

  return {
    appId,
    prefix,
    files,
    source: "per-app-github-tree",
    commitSha,
  };
}

export type CloudSyncServiceInstance = NonNullable<ReturnType<typeof getCloudSyncService>>;
