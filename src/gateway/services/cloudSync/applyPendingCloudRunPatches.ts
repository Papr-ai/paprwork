import type { JobRuntimePatch } from "../../types/cloudRuntime.js";
import type { JobsService } from "../JobsService.js";

export interface ApplyPendingCloudRunPatchesResult {
  applied: number;
  /** Terminal patches missing scheduleState.nextRunAt that could not be applied. */
  incompletePatches: number;
}

export interface ApplyPendingCloudRunPatchesDeps {
  jobsService: Pick<JobsService, "initialize" | "applyCloudRunPatch">;
}

/**
 * Apply heartbeat pendingCloudRuns (job runtime is always off git).
 * V3: no git fallback — incomplete patches are counted for logging only.
 */
export async function applyPendingCloudRunPatches(
  pending: JobRuntimePatch[],
  deps: ApplyPendingCloudRunPatchesDeps,
): Promise<ApplyPendingCloudRunPatchesResult> {
  await deps.jobsService.initialize();

  let applied = 0;
  let incompletePatches = 0;

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
      incompletePatches++;
    }
  }

  return { applied, incompletePatches };
}
