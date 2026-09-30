/**
 * Reconcile sync-state fingerprints when git working tree is already clean.
 */

import * as fs from "fs";
import * as path from "path";
import { canReconcilePathAsSynced } from "./gitPathStatus.js";
import type { SyncStateManager } from "./syncState.js";
import type { RunGitFn } from "./gitStageScope.js";

export async function reconcilePathsIfGitClean(
  paprDir: string,
  relativePaths: readonly string[],
  git: RunGitFn,
  stateManager: SyncStateManager,
  removeFromQueue: (paths: readonly string[]) => void,
): Promise<string[]> {
  const reconciled: string[] = [];

  for (const relativePath of relativePaths) {
    const fullPath = path.join(paprDir, relativePath);
    const exists = fs.existsSync(fullPath);
    let porcelain = "";
    let trackedFiles = "";
    try {
      porcelain = exists
        ? await git(["status", "--porcelain", "--", relativePath])
        : "";
      trackedFiles = exists
        ? await git(["ls-files", "--", relativePath])
        : "";
    } catch {
      continue;
    }

    if (
      !canReconcilePathAsSynced({
        exists,
        porcelain,
        trackedFiles,
      })
    ) {
      continue;
    }

    const prev = stateManager.data.syncedItems[relativePath];
    if (!prev || stateManager.hasItemChanged(relativePath)) {
      stateManager.markSynced(relativePath);
      reconciled.push(relativePath);
    }
  }

  if (reconciled.length > 0) {
    removeFromQueue(reconciled);
    stateManager.save();
    console.log(
      `[CloudSync] Reconciled ${reconciled.length} path(s) already clean in git`,
    );
  }

  return reconciled;
}
