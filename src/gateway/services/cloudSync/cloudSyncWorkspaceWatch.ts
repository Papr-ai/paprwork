/**
 * Hash-gated workspace/data watcher (small dirs only — no EMFILE on apps/Jobs).
 */

import * as fs from "fs";
import * as path from "path";
import { TreeWatcher } from "../TreeWatcher.js";
import { shouldAutoUploadRelativePath } from "../cloudUploadMode.js";
import { ensureWorkspaceGitignore } from "./workspaceGitignore.js";
import type { SyncStateManager } from "./syncState.js";

export const INSTANT_DIRS = ["workspace", "data"] as const;

/** Mirrors the old chokidar `ignored` list: .git trees and SQLite files/sidecars. */
export function isIgnoredWorkspaceWatchPath(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.includes("/.git/")) return true;
  return /\.db(-wal|-shm|-changes|-journal)?$/.test(normalized);
}

export interface CloudSyncWorkspaceWatchHost {
  getPaprDir(): string;
  getPushDebounceMs(): number;
  getSyncStatus(): "idle" | "syncing" | "queuing" | "error";
  getStateManager(): SyncStateManager;
  clearPushTimer(): void;
  schedulePushTimer(callback: () => void, delayMs: number): void;
  setWatcher(watcher: TreeWatcher | null): void;
}

export function getChangedInstantPaths(
  paprDir: string,
  stateManager: SyncStateManager,
): string[] {
  ensureWorkspaceGitignore(paprDir);
  const paths: string[] = [];
  for (const dir of INSTANT_DIRS) {
    if (!fs.existsSync(path.join(paprDir, dir))) {
      continue;
    }
    if (stateManager.hasItemChanged(dir)) {
      paths.push(dir);
    }
  }
  if (stateManager.hasItemChanged(".gitignore")) {
    paths.push(".gitignore");
  }
  return paths;
}

export async function syncWorkspaceIfChanged(
  host: CloudSyncWorkspaceWatchHost,
): Promise<boolean> {
  if (host.getSyncStatus() === "queuing") {
    return false;
  }
  const paprDir = host.getPaprDir();
  if (!shouldAutoUploadRelativePath("workspace", paprDir)) {
    return false;
  }

  const paths = getChangedInstantPaths(paprDir, host.getStateManager());
  if (paths.length === 0) {
    return false;
  }

  const stateManager = host.getStateManager();
  for (const relativePath of paths) {
    stateManager.markSynced(relativePath);
  }
  stateManager.save();
  console.log(
    `[CloudSync] Workspace/data change tracked locally (${paths.length} path(s); namespace git push disabled — Sync V3)`,
  );
  return false;
}

export function startWorkspaceWatcher(host: CloudSyncWorkspaceWatchHost): void {
  const paprDir = host.getPaprDir();
  const watchPaths = INSTANT_DIRS.map((d) => path.join(paprDir, d)).filter((p) =>
    fs.existsSync(p),
  );
  if (watchPaths.length === 0) {
    return;
  }

  console.log(`[CloudSync] Watching ${watchPaths.length} dirs (workspace, data) — 1 OS watch per root`);

  const scheduleDebounce = () => {
    host.clearPushTimer();
    host.schedulePushTimer(() => {
      void syncWorkspaceIfChanged(host);
    }, host.getPushDebounceMs());
  };

  const watcher = new TreeWatcher({
    roots: watchPaths,
    recursive: true,
    settleMs: 1000, // was chokidar awaitWriteFinish.stabilityThreshold
    ignore: isIgnoredWorkspaceWatchPath,
    onEvent: () => scheduleDebounce(),
    onError: (err) => {
      if (!String(err).includes("EMFILE")) {
        console.error("[CloudSync] Watcher error:", err?.message ?? String(err));
      }
    },
  });

  host.setWatcher(watcher);
}
