/**
 * Per-item GitHub (CloudSync) status for Settings UI.
 */

import * as fs from "fs";
import * as path from "path";
import type { DeadLetterItem, PersistedSyncState } from "./syncState.js";
import { inferGitRemoteReviewState, summarizeIncomingRemoteGitLog } from "./gitRemoteReconcile.js";

export type GitHubItemSyncState =
  | "synced"
  | "pending"
  | "outdated"
  | "failed"
  | "updates_available";

export interface GitHubSyncItem {
  id: string;
  kind: "app" | "job" | "folder";
  label: string;
  relativePath: string;
  status: GitHubItemSyncState;
  lastSyncAt: string | null;
  lastError?: string | null;
  failedAt?: string | null;
  /** Local changes exist but auto-upload is off — use Upload now. */
  manualUploadHold?: boolean;
}

export interface GitHubSyncItemsReport {
  workspace: GitHubSyncItem[];
  apps: GitHubSyncItem[];
  jobs: GitHubSyncItem[];
  /** Paths currently in the background upload queue. */
  queuedPaths: string[];
  /** Remote git has commits local lacks (§6 owner review). */
  gitUpdatesAvailable?: boolean;
  gitUpdatesSummary?: string | null;
  /** True when remote changes include app/job source code (not job status metadata). */
  gitRemoteRequiresReview?: boolean;
  /** True when only cloud job status metadata is pending integration. */
  gitRemoteMetadataSync?: boolean;
  /** Short headline for owner-review banner (e.g. contrib merge + job status). */
  gitRemoteReviewHeadline?: string | null;
  summary: {
    synced: number;
    pending: number;
    outdated: number;
    failed: number;
    updatesAvailable: number;
    total: number;
  };
}

interface AppIndexEntry {
  id: string;
  title?: string;
}

interface JobIndexEntry {
  id: string;
  name?: string;
}

/** True when incoming remote commits touched files under this sync folder. */
export function folderHasIncomingRemoteChanges(
  folderRelativePath: string,
  remoteChangedPaths: ReadonlySet<string> | undefined,
): boolean {
  if (!remoteChangedPaths || remoteChangedPaths.size === 0) {
    return false;
  }
  const folder = folderRelativePath.replace(/\\/g, "/");
  for (const changed of remoteChangedPaths) {
    const normalized = changed.replace(/\\/g, "/");
    if (normalized === folder || normalized.startsWith(`${folder}/`)) {
      return true;
    }
  }
  return false;
}

export function resolveGitHubItemSyncStatus(
  relativePath: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: readonly string[],
  hasItemChanged: (relativePath: string) => boolean,
  deadLetter?: Readonly<Record<string, DeadLetterItem>>,
  trackedInGit?: ReadonlySet<string>,
  gitUpdatesAvailable?: boolean,
  gitRemoteChangedPaths?: ReadonlySet<string>,
): GitHubItemSyncState {
  return resolveItemStatus(
    relativePath,
    syncedItems,
    new Set(queuedPaths),
    hasItemChanged,
    deadLetter,
    trackedInGit,
    gitUpdatesAvailable,
    gitRemoteChangedPaths,
  );
}

function resolveItemStatus(
  relativePath: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
  deadLetter?: Readonly<Record<string, DeadLetterItem>>,
  trackedInGit?: ReadonlySet<string>,
  gitUpdatesAvailable?: boolean,
  gitRemoteChangedPaths?: ReadonlySet<string>,
): GitHubItemSyncState {
  if (deadLetter?.[relativePath]) {
    return "failed";
  }
  const prev = syncedItems[relativePath];
  const changed = hasItemChanged(relativePath);
  if (
    gitUpdatesAvailable &&
    prev &&
    !changed &&
    !queuedPaths.has(relativePath) &&
    folderHasIncomingRemoteChanges(relativePath, gitRemoteChangedPaths)
  ) {
    return "updates_available";
  }
  if (prev && !changed) {
    // Already on GitHub — stale background queue entries must not show as pending.
    return "synced";
  }
  if (trackedInGit?.has(relativePath) && !changed) {
    // Tracked in git with a clean working tree — synced even if sync-state was never written
    // (common after workspace switch, state reset, or while another folder uploads).
    return "synced";
  }
  if (queuedPaths.has(relativePath)) {
    return "pending";
  }
  if (!prev) {
    // Missing sync-state entry but git already has commits → local changes pending push,
    // not "never uploaded" (common after invalidateAllSyncedItems or state file reset).
    if (trackedInGit?.has(relativePath)) {
      return "outdated";
    }
    return "pending";
  }
  return hasItemChanged(relativePath) ? "outdated" : "synced";
}

function loadAppTitles(paprDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const apps = JSON.parse(raw) as AppIndexEntry[] | Record<string, AppIndexEntry>;
    const list = Array.isArray(apps) ? apps : Object.values(apps);
    for (const app of list) {
      if (app.id) {
        titles.set(app.id, app.title?.trim() || app.id.slice(0, 8));
      }
    }
  } catch {
    /* optional index */
  }
  return titles;
}

function loadJobNames(paprDir: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "jobs.json"), "utf8");
    const parsed = JSON.parse(raw) as { jobs?: JobIndexEntry[] } | JobIndexEntry[];
    const list = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
    for (const job of list) {
      if (job.id) {
        names.set(job.id, job.name?.trim() || job.id.slice(0, 8));
      }
    }
  } catch {
    /* optional index */
  }
  return names;
}

function listChildDirs(paprDir: string, parent: string): string[] {
  const parentPath = path.join(paprDir, parent);
  if (!fs.existsSync(parentPath)) {
    return [];
  }
  return fs
    .readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(parent, entry.name));
}

function buildFolderItems(
  _paprDir: string,
  folders: readonly string[],
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
  deadLetter?: Readonly<Record<string, DeadLetterItem>>,
  trackedInGit?: ReadonlySet<string>,
  gitUpdatesAvailable?: boolean,
  shouldAutoUploadPath?: (relativePath: string) => boolean,
  gitRemoteChangedPaths?: ReadonlySet<string>,
): GitHubSyncItem[] {
  return folders.map((relativePath) => {
    const dead = deadLetter?.[relativePath];
    const status = resolveItemStatus(
      relativePath,
      syncedItems,
      queuedPaths,
      hasItemChanged,
      deadLetter,
      trackedInGit,
      gitUpdatesAvailable,
      gitRemoteChangedPaths,
    );
    const manualUploadHold =
      shouldAutoUploadPath !== undefined &&
      !shouldAutoUploadPath(relativePath) &&
      (status === "pending" || status === "outdated");
    return {
      id: relativePath.replace("/", "-"),
      kind: "folder" as const,
      label: relativePath === "workspace" ? "Workspace" : "Settings & data",
      relativePath,
      status,
      lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
      lastError: dead?.lastError ?? null,
      failedAt: dead?.lastFailedAt ?? null,
      manualUploadHold: manualUploadHold || undefined,
    };
  });
}

function buildAppItems(
  paprDir: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
  deadLetter?: Readonly<Record<string, DeadLetterItem>>,
  trackedInGit?: ReadonlySet<string>,
  gitUpdatesAvailable?: boolean,
  shouldAutoUploadPath?: (relativePath: string) => boolean,
  gitRemoteChangedPaths?: ReadonlySet<string>,
): GitHubSyncItem[] {
  const titles = loadAppTitles(paprDir);
  return listChildDirs(paprDir, "apps")
    .map((relativePath) => {
      const id = path.basename(relativePath);
      const dead = deadLetter?.[relativePath];
      const status = resolveItemStatus(
        relativePath,
        syncedItems,
        queuedPaths,
        hasItemChanged,
        deadLetter,
        trackedInGit,
        gitUpdatesAvailable,
        gitRemoteChangedPaths,
      );
      const manualUploadHold =
        shouldAutoUploadPath !== undefined &&
        !shouldAutoUploadPath(relativePath) &&
        (status === "pending" || status === "outdated");
      return {
        id,
        kind: "app" as const,
        label: titles.get(id) ?? id.slice(0, 8),
        relativePath,
        status,
        lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
        lastError: dead?.lastError ?? null,
        failedAt: dead?.lastFailedAt ?? null,
        manualUploadHold: manualUploadHold || undefined,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function listJobIds(paprDir: string): string[] {
  const ids = new Set<string>();
  for (const parent of ["Jobs", "jobs"] as const) {
    for (const relativePath of listChildDirs(paprDir, parent)) {
      ids.add(path.basename(relativePath));
    }
  }
  return [...ids].sort();
}

function buildJobItems(
  paprDir: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
  deadLetter?: Readonly<Record<string, DeadLetterItem>>,
  trackedInGit?: ReadonlySet<string>,
  gitUpdatesAvailable?: boolean,
  shouldAutoUploadPath?: (relativePath: string) => boolean,
  gitRemoteChangedPaths?: ReadonlySet<string>,
): GitHubSyncItem[] {
  const names = loadJobNames(paprDir);
  return listJobIds(paprDir)
    .map((id) => {
      const relativePath = path.join("Jobs", id);
      const dead = deadLetter?.[relativePath];
      const status = resolveItemStatus(
        relativePath,
        syncedItems,
        queuedPaths,
        hasItemChanged,
        deadLetter,
        trackedInGit,
        gitUpdatesAvailable,
        gitRemoteChangedPaths,
      );
      const manualUploadHold =
        shouldAutoUploadPath !== undefined &&
        !shouldAutoUploadPath(relativePath) &&
        (status === "pending" || status === "outdated");
      return {
        id,
        kind: "job" as const,
        label: names.get(id) ?? id.slice(0, 8),
        relativePath,
        status,
        lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
        lastError: dead?.lastError ?? null,
        failedAt: dead?.lastFailedAt ?? null,
        manualUploadHold: manualUploadHold || undefined,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function summarize(items: GitHubSyncItem[]): GitHubSyncItemsReport["summary"] {
  let synced = 0;
  let pending = 0;
  let outdated = 0;
  let failed = 0;
  let updatesAvailable = 0;
  for (const item of items) {
    if (item.status === "synced") synced += 1;
    else if (item.status === "outdated") outdated += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "updates_available") updatesAvailable += 1;
    else pending += 1;
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

export function buildGitHubSyncItemsReport(opts: {
  paprDir: string;
  syncedItems: PersistedSyncState["syncedItems"];
  queuedPaths: readonly string[];
  hasItemChanged: (relativePath: string) => boolean;
  deadLetter?: Readonly<Record<string, DeadLetterItem>>;
  trackedInGit?: ReadonlySet<string>;
  gitUpdatesAvailable?: boolean;
  gitUpdatesSummary?: string | null;
  gitRemoteChangedPaths?: ReadonlySet<string>;
  shouldAutoUploadPath?: (relativePath: string) => boolean;
}): GitHubSyncItemsReport {
  const queuedSet = new Set(opts.queuedPaths);
  const deadLetter = opts.deadLetter ?? {};
  const gitUpdatesAvailable = opts.gitUpdatesAvailable === true;
  const remotePaths = opts.gitRemoteChangedPaths;
  const remoteReview = inferGitRemoteReviewState({
    gitUpdatesAvailable,
    remoteChangedPaths: remotePaths ? [...remotePaths] : null,
    gitUpdatesSummary: opts.gitUpdatesSummary,
  });
  const reviewHeadline = gitUpdatesAvailable
    ? summarizeIncomingRemoteGitLog(
        opts.gitUpdatesSummary,
        remotePaths ? [...remotePaths] : undefined,
      ).headline
    : null;
  const workspace = buildFolderItems(
    opts.paprDir,
    ["workspace", "data"],
    opts.syncedItems,
    queuedSet,
    opts.hasItemChanged,
    deadLetter,
    opts.trackedInGit,
    gitUpdatesAvailable,
    opts.shouldAutoUploadPath,
    remotePaths,
  );
  const apps = buildAppItems(
    opts.paprDir,
    opts.syncedItems,
    queuedSet,
    opts.hasItemChanged,
    deadLetter,
    opts.trackedInGit,
    gitUpdatesAvailable,
    opts.shouldAutoUploadPath,
    remotePaths,
  );
  const jobs = buildJobItems(
    opts.paprDir,
    opts.syncedItems,
    queuedSet,
    opts.hasItemChanged,
    deadLetter,
    opts.trackedInGit,
    gitUpdatesAvailable,
    opts.shouldAutoUploadPath,
    remotePaths,
  );
  const all = [...workspace, ...apps, ...jobs];
  return {
    workspace,
    apps,
    jobs,
    queuedPaths: [...opts.queuedPaths],
    gitUpdatesAvailable: gitUpdatesAvailable || undefined,
    gitUpdatesSummary: opts.gitUpdatesSummary ?? null,
    gitRemoteRequiresReview: remoteReview.requiresReview || undefined,
    gitRemoteMetadataSync: remoteReview.metadataSync || undefined,
    gitRemoteReviewHeadline: reviewHeadline,
    summary: summarize(all),
  };
}
