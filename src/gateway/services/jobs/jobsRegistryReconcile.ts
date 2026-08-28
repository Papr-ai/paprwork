/**
 * Reconcile jobs registry after cloud/git sync or manual reload.
 */

import { getJobsService } from "../JobsService.js";
import { waitForWorkspaceReady } from "../workspaceReadiness.js";

export interface JobsRegistryReconcileResult {
  tombstonesRemoved: number;
  duplicatesReconciled: boolean;
  duplicateIdsRemoved: string[];
}

export async function reconcileJobsRegistryAfterSync(): Promise<JobsRegistryReconcileResult> {
  await waitForWorkspaceReady();

  const jobsService = getJobsService();
  await jobsService.initialize();
  return jobsService.reconcileRegistryAfterSync();
}
