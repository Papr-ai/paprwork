/**
 * Ordered flush for auto-upload app folders (shared by queue processor + pushGitNow).
 */

import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import { shouldAutoUploadApp } from "../cloudUploadMode.js";
import type { FlushNowOptions } from "./coordinatorTypes.js";

export function parseAppIdFromAppsRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  const match = /^apps\/([^/]+)$/.exec(normalized);
  return match?.[1] ?? null;
}

/** True when this folder was handled via ordered flush (caller should skip git-only push). */
export async function flushAutoUploadAppFolderIfNeeded(
  sync: CloudSyncService,
  relativePath: string,
  trigger: FlushNowOptions["trigger"],
): Promise<boolean> {
  const appId = parseAppIdFromAppsRelativePath(relativePath);
  if (!appId || !shouldAutoUploadApp(appId, sync.getPaprDir())) {
    return false;
  }

  const { getSyncCoordinator } = await import("./SyncCoordinator.js");
  const coordinator = getSyncCoordinator();
  if (!coordinator) {
    return false;
  }

  const result = await coordinator.flushNow(appId, { trigger: trigger ?? "auto" });
  if (result.webReady || result.published || result.tursoPushed) {
    sync.markRelativePathSynced(relativePath);
  }
  return true;
}

export function appsRelativePath(appId: string): string {
  return path.join("apps", appId);
}
