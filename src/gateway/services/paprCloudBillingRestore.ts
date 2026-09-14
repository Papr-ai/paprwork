/**
 * Clears gateway Papr Cloud pause after billing is restored (active/trialing).
 * Heavy vault sync is scheduled when the interactive path is quiet (Phase A).
 */

import { setPaprCloudPaused } from "../../core/utils/paprQuota.js";
import { resumeCodeIndexingAfterBillingRestore } from "./CodeIndexingService.js";
import { getVaultSyncService } from "./VaultSyncService.js";
import {
  isCoalescedBackgroundTaskInFlight,
  scheduleCoalescedBackgroundWork,
} from "./gatewayBackgroundWork.js";

const PAPR_RESUME_CLOUD_TASK = "papr:resume-cloud";

/**
 * Immediate: unpause cloud features and allow code index to resume scheduling.
 * Deferred: full vault push/pull when chat/apps are not busy.
 */
export function schedulePaprCloudResumeAfterBillingRestore(): void {
  setPaprCloudPaused(false);
  resumeCodeIndexingAfterBillingRestore();

  if (isCoalescedBackgroundTaskInFlight("vault:workspace-switch")) {
    console.log(
      "[PaprCloud] Skipping papr:resume-cloud — workspace vault sync already running",
    );
    return;
  }

  scheduleCoalescedBackgroundWork(PAPR_RESUME_CLOUD_TASK, async () => {
    if (isCoalescedBackgroundTaskInFlight("vault:workspace-switch")) {
      console.log(
        "[PaprCloud] Skipping papr:resume-cloud body — workspace vault sync in progress",
      );
      return;
    }
    const vault = getVaultSyncService();
    if (!vault) {
      return;
    }
    await vault.runFullSync();
  });
}

/** @deprecated Prefer schedulePaprCloudResumeAfterBillingRestore — kept for direct calls. */
export async function resumePaprCloudAfterBillingRestore(): Promise<void> {
  schedulePaprCloudResumeAfterBillingRestore();
}
