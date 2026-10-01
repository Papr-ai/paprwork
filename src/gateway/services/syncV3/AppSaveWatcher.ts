/**
 * App save → writer ops dirty signal (Sync V3).
 */

import { shouldAutoUploadApp } from "../cloudUploadMode.js";
import { notifyCloudSyncItemsStale } from "../cloudSync/cloudSyncBroadcast.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export function isWriterOpsSavePathEnabled(): boolean {
  return true;
}

/**
 * Returns true when an auto flush was scheduled.
 *
 * Manual-upload apps get no flush, but the publish bar still has to learn the
 * app is dirty. Without this broadcast the renderer kept its last "synced"
 * snapshot and greyed Publish out ("Everything here is already on the web")
 * while unpublished edits sat on disk. Auto-upload apps don't need it here:
 * the flush they schedule broadcasts on completion.
 */
export async function notifyAppSaveForWriterOps(
  appId: string,
  scheduleAutoFlush: (appId: string) => void,
  paprDir?: string,
  notifyStale: (appId: string) => void = notifyCloudSyncItemsStale,
): Promise<boolean> {
  const root = paprDir ?? getPaprRoot();
  if (!shouldAutoUploadApp(appId, root)) {
    notifyStale(appId);
    return false;
  }
  scheduleAutoFlush(appId);
  return true;
}
