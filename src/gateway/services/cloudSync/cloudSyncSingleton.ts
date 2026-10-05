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
    // Breaking migrations left held by a previous run: publish them now (Phase 3).
    // Must run after the coordinator exists — cloud sync starts minutes after boot.
    return import("../tursoReplica/scheduleHeldPublishes.js").then(({ scheduleHeldPublishes }) =>
      scheduleHeldPublishes("startup"),
    );
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
