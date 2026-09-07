/**
 * Repair stale Sync V3 writer publish baselines (OID cache + outbox failures).
 *
 * Used when push_cloud_sync returns writer 409 but Get updates has nothing to
 * pull — local cloud-prep bookkeeping drifted from the per-app repo HEAD.
 */

import { fetchAppRepoHead } from "./AppOpsClient.js";
import { writeAppRepoCommitCursor } from "./appRepoCommittedFanout.js";
import { overwriteOidCacheFromHead } from "./OidCache.js";
import { clearWriterOutboxFailureEntries } from "./SyncOutbox.js";
import { clearWriterConflictsForApp } from "./writerConflict.js";

export interface ResetWriterBaselineResult {
  appId: string;
  remoteCommitSha: string;
  pathsReseeded: number;
  outboxFailuresCleared: number;
  conflictEventsCleared: number;
  resetAt: string;
}

export async function resetWriterBaseline(
  appId: string,
): Promise<ResetWriterBaselineResult> {
  const trimmed = appId.trim();
  if (!trimmed) {
    throw new Error("appId is required");
  }

  const head = await fetchAppRepoHead(trimmed, { seedOidCache: false });
  const pathsReseeded = await overwriteOidCacheFromHead(trimmed, head.files);
  await writeAppRepoCommitCursor(trimmed, head.commitSha);

  const outboxFailuresCleared = await clearWriterOutboxFailureEntries(trimmed);
  const conflictEventsCleared = clearWriterConflictsForApp(trimmed);

  const { getSyncCoordinator } = await import("../cloudSync/SyncCoordinator.js");
  getSyncCoordinator()?.clearFlushErrorState(trimmed);

  const sync = (await import("../CloudSyncService.js")).getCloudSyncService();
  sync?.clearManualFlushError(trimmed);

  return {
    appId: trimmed,
    remoteCommitSha: head.commitSha,
    pathsReseeded,
    outboxFailuresCleared,
    conflictEventsCleared,
    resetAt: new Date().toISOString(),
  };
}
