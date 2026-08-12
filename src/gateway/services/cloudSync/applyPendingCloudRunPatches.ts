import type { JobRuntimePatch } from "../../types/cloudRuntime.js";
import type { JobsService } from "../JobsService.js";

export interface ApplyPendingCloudRunPatchesResult {
  applied: number;
  needsGitFallback: boolean;
}

export interface ApplyPendingCloudRunPatchesDeps {
  jobsService: Pick<JobsService, "initialize" | "applyCloudRunPatch">;
}

/**
 * Apply heartbeat pendingCloudRuns when JOB_RUNTIME_OFF_GIT is enabled.
 * Returns whether caller should fall back to git pull for incomplete patches.
 */
export async function applyPendingCloudRunPatches(
  pending: JobRuntimePatch[],
  deps: ApplyPendingCloudRunPatchesDeps,
): Promise<ApplyPendingCloudRunPatchesResult> {
  await deps.jobsService.initialize();

  let applied = 0;
  let needsGitFallback = false;

  for (const patch of pending) {
    const result = await deps.jobsService.applyCloudRunPatch(patch);
    if (result) {
      applied++;
      continue;
    }

    const terminal =
      patch.status === "completed" ||
      patch.status === "failed" ||
      patch.status === "cancelled";
    if (terminal && !patch.scheduleState?.nextRunAt) {
      needsGitFallback = true;
    }
  }

  return { applied, needsGitFallback };
}
