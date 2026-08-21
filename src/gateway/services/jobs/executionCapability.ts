import type { JobRecord } from "./types.js";

/** Scheduled execution placement when cloud sync is enabled. */
export type JobExecutionCapability =
  | "local-only"
  | "local-preferred"
  | "cloud-preferred"
  /** @deprecated Legacy alias — treated as local-preferred. */
  | "cloud-capable";

export type JobExecutionCapabilityInput = JobExecutionCapability | undefined;

export type NormalizedJobExecutionCapability =
  | "local-only"
  | "local-preferred"
  | "cloud-preferred";

/** Default for new jobs and unset legacy records. */
export const DEFAULT_JOB_EXECUTION_CAPABILITY: NormalizedJobExecutionCapability =
  "local-preferred";

export function normalizeExecutionCapability(
  value: JobExecutionCapabilityInput,
): NormalizedJobExecutionCapability {
  if (value === "local-only") {
    return "local-only";
  }
  if (value === "cloud-preferred") {
    return "cloud-preferred";
  }
  return DEFAULT_JOB_EXECUTION_CAPABILITY;
}

/** True when the desktop JobsScheduler should fire this job on schedule. */
export function shouldDesktopSchedulerRunJob(
  job: Pick<JobRecord, "executionCapability">,
  cloudSchedulerAuthoritative: boolean,
): boolean {
  if (!cloudSchedulerAuthoritative) {
    return true;
  }
  return normalizeExecutionCapability(job.executionCapability) !== "cloud-preferred";
}

/** True when a due job is intentionally skipped locally (cloud scheduler owns the slot). */
export function isJobDeferredToCloudScheduler(
  job: Pick<JobRecord, "executionCapability">,
  cloudSchedulerAuthoritative: boolean,
): boolean {
  return (
    cloudSchedulerAuthoritative &&
    !shouldDesktopSchedulerRunJob(job, cloudSchedulerAuthoritative)
  );
}
