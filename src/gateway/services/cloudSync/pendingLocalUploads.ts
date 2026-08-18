/**
 * Detect app/job folders with local edits not yet uploaded to the Papr cloud git repo.
 * Used to defer git pull and Turso cloud→local reconcile so stale remote state cannot
 * overwrite in-progress agent work (SYNC_CONTRACT §6).
 */

import * as fs from "fs";
import * as path from "path";
import { SyncStateManager } from "./syncState.js";

const QUEUED_DIRS = ["apps", "Jobs"] as const;

export function listPendingUploadRelativePaths(
  paprDir: string,
  stateManager: SyncStateManager,
): string[] {
  const pending: string[] = [];
  for (const parent of QUEUED_DIRS) {
    const parentPath = path.join(paprDir, parent);
    if (!fs.existsSync(parentPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = `${parent}/${entry.name}`;
      if (stateManager.hasItemChanged(relativePath)) {
        pending.push(relativePath);
      }
    }
  }
  return pending;
}

export function hasPendingLocalUploads(
  paprDir: string,
  stateManager: SyncStateManager,
): boolean {
  return listPendingUploadRelativePaths(paprDir, stateManager).length > 0;
}

export function appHasPendingLocalUpload(
  appId: string,
  stateManager: SyncStateManager,
): boolean {
  return stateManager.hasItemChanged(`apps/${appId}`);
}

/** Load sync state from disk and check whether a mini-app still has unpushed git work. */
export function readAppHasPendingLocalUpload(
  appId: string,
  paprDir: string,
): boolean {
  const mgr = new SyncStateManager(paprDir);
  mgr.load();
  return appHasPendingLocalUpload(appId, mgr);
}

export function formatPendingUploadDeferReason(
  pendingPaths: readonly string[],
): string {
  if (pendingPaths.length === 0) {
    return "pending local upload(s)";
  }
  const preview = pendingPaths.slice(0, 3).join(", ");
  const suffix =
    pendingPaths.length > 3 ? ` (+${pendingPaths.length - 3} more)` : "";
  return `pending local upload(s): ${preview}${suffix}`;
}
