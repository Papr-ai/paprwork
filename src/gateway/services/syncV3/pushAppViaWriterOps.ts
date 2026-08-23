/**
 * Flush app code via Sync V3 writer ops (replaces direct git push for app folder).
 */

import type { CloudSyncService } from "../CloudSyncService.js";
import { pushAppViaWriterOpsFromSync } from "./pushAppWriterOpsCore.js";

export interface PushAppViaWriterResult {
  appId: string;
  commitSha?: string;
  filesSent: number;
  skippedUnchanged: number;
  outboxReplayed: number;
  /**
   * Changed files held back by the batch budget. Non-zero means this app has
   * more to send and needs another flush to converge.
   */
  deferred: number;
}

export async function pushAppViaWriterOps(
  sync: CloudSyncService,
  appId: string,
  message?: string,
): Promise<PushAppViaWriterResult> {
  return pushAppViaWriterOpsFromSync(sync, appId, message);
}
