/**
 * Per-item GitHub (CloudSync) status for Settings UI.
 */

import * as fs from "fs";
import * as path from "path";
import type { PersistedSyncState } from "./syncState.js";

export type GitHubItemSyncState = "synced" | "pending" | "outdated";

export interface GitHubSyncItem {
  id: string;
  kind: "app" | "job" | "folder";
  label: string;
  relativePath: string;
  status: GitHubItemSyncState;
  lastSyncAt: string | null;
}

export interface GitHubSyncItemsReport {
  workspace: GitHubSyncItem[];
  apps: GitHubSyncItem[];
  jobs: GitHubSyncItem[];
  /** Paths currently in the background upload queue. */
  queuedPaths: string[];
  summary: {
    synced: number;
    pending: number;
    outdated: number;
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

export function resolveGitHubItemSyncStatus(
  relativePath: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: readonly string[],
  hasItemChanged: (relativePath: string) => boolean,
): GitHubItemSyncState {
  return resolveItemStatus(
    relativePath,
    syncedItems,
    new Set(queuedPaths),
    hasItemChanged,
  );
}

function resolveItemStatus(
  relativePath: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
): GitHubItemSyncState {
  const prev = syncedItems[relativePath];
  if (prev && !hasItemChanged(relativePath)) {
    // Already on GitHub — stale background queue entries must not show as pending.
    return "synced";
  }
  if (queuedPaths.has(relativePath)) {
    return "pending";
  }
  if (!prev) {
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
): GitHubSyncItem[] {
  return folders.map((relativePath) => ({
    id: relativePath.replace("/", "-"),
    kind: "folder" as const,
    label: relativePath === "workspace" ? "Workspace" : "Settings & data",
    relativePath,
    status: resolveItemStatus(relativePath, syncedItems, queuedPaths, hasItemChanged),
    lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
  }));
}

function buildAppItems(
  paprDir: string,
  syncedItems: PersistedSyncState["syncedItems"],
  queuedPaths: ReadonlySet<string>,
  hasItemChanged: (relativePath: string) => boolean,
): GitHubSyncItem[] {
  const titles = loadAppTitles(paprDir);
  return listChildDirs(paprDir, "apps")
    .map((relativePath) => {
      const id = path.basename(relativePath);
      return {
        id,
        kind: "app" as const,
        label: titles.get(id) ?? id.slice(0, 8),
        relativePath,
        status: resolveItemStatus(relativePath, syncedItems, queuedPaths, hasItemChanged),
        lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
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
): GitHubSyncItem[] {
  const names = loadJobNames(paprDir);
  return listJobIds(paprDir)
    .map((id) => {
      const relativePath = path.join("Jobs", id);
      return {
        id,
        kind: "job" as const,
        label: names.get(id) ?? id.slice(0, 8),
        relativePath,
        status: resolveItemStatus(relativePath, syncedItems, queuedPaths, hasItemChanged),
        lastSyncAt: syncedItems[relativePath]?.lastSyncAt ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function summarize(items: GitHubSyncItem[]): GitHubSyncItemsReport["summary"] {
  let synced = 0;
  let pending = 0;
  let outdated = 0;
  for (const item of items) {
    if (item.status === "synced") synced += 1;
    else if (item.status === "outdated") outdated += 1;
    else pending += 1;
  }
  return { synced, pending, outdated, total: items.length };
}

export function buildGitHubSyncItemsReport(opts: {
  paprDir: string;
  syncedItems: PersistedSyncState["syncedItems"];
  queuedPaths: readonly string[];
  hasItemChanged: (relativePath: string) => boolean;
}): GitHubSyncItemsReport {
  const queuedSet = new Set(opts.queuedPaths);
  const workspace = buildFolderItems(
    opts.paprDir,
    ["workspace", "data"],
    opts.syncedItems,
    queuedSet,
    opts.hasItemChanged,
  );
  const apps = buildAppItems(opts.paprDir, opts.syncedItems, queuedSet, opts.hasItemChanged);
  const jobs = buildJobItems(opts.paprDir, opts.syncedItems, queuedSet, opts.hasItemChanged);
  const all = [...workspace, ...apps, ...jobs];
  return {
    workspace,
    apps,
    jobs,
    queuedPaths: [...opts.queuedPaths],
    summary: summarize(all),
  };
}
