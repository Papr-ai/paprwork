/**
 * Process-wide CloudSyncService singleton.
 */

import { CloudSyncService } from "../CloudSyncService.js";

let instance: CloudSyncService | null = null;

export function initializeCloudSyncService(opts?: {
  pushDebounceMs?: number;
  queueIntervalMs?: number;
}): CloudSyncService {
  if (instance) {
    console.warn(
      "[CloudSync] initializeCloudSyncService called while instance exists — stopping orphaned timers",
    );
    void instance.stop();
  }
  instance = new CloudSyncService(opts);
  void import("./SyncCoordinator.js").then(({ initializeSyncCoordinator }) => {
    initializeSyncCoordinator(instance!);
    console.log("[CloudSync] SyncCoordinator ready");
  });
  return instance;
}

export function getCloudSyncService(): CloudSyncService | null {
  return instance;
}

export async function resetCloudSyncServiceForWorkspaceSwitch(): Promise<void> {
  if (!instance) {
    return;
  }
  await instance.stop();
  instance = null;
  const { resetSyncCoordinatorForWorkspaceSwitch } = await import("./SyncCoordinator.js");
  await resetSyncCoordinatorForWorkspaceSwitch();
}
