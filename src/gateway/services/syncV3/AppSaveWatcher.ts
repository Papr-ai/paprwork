/**
 * App save → writer ops dirty signal (Sync V3).
 */

import { shouldAutoUploadApp } from "../cloudUploadMode.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export function isWriterOpsSavePathEnabled(): boolean {
  return true;
}

export async function notifyAppSaveForWriterOps(
  appId: string,
  scheduleAutoFlush: (appId: string) => void,
  paprDir?: string,
): Promise<boolean> {
  const root = paprDir ?? getPaprRoot();
  if (!shouldAutoUploadApp(appId, root)) {
    return false;
  }
  scheduleAutoFlush(appId);
  return true;
}
