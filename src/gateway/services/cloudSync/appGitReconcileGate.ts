/**
 * Skip git reconcile when local sync fingerprints already match disk (no git needed).
 */

import * as fs from "fs";
import * as path from "path";
import {
  jobRelativePath,
  resolveAppDependentJobIds,
} from "./resolveAppDependentJobs.js";
import type { SyncStateManager } from "./syncState.js";

/** App folder + dependent job folders used for cloud sync reconciliation. */
export function listAppDependentSyncRelativePaths(
  paprDir: string,
  appId: string,
): string[] {
  const jobIds = resolveAppDependentJobIds(paprDir, appId);
  const paths = [`apps/${appId}`, ...jobIds.map(jobRelativePath)];
  return [...new Set(paths)];
}

/**
 * True when git reconcile might fix sync-state vs working tree drift
 * (fingerprint says changed, or path never marked synced).
 */
export function appDependentPathsNeedGitReconcile(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): boolean {
  for (const relativePath of listAppDependentSyncRelativePaths(paprDir, appId)) {
    const fullPath = path.join(paprDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    if (stateManager.hasItemChanged(relativePath)) {
      return true;
    }
  }
  return false;
}
