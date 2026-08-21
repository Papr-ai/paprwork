import type { JobRecord } from "./types.js";
import { isStandaloneOnly, STANDALONE_APP_ID } from "./appIds.js";

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

/** Default for app-linked jobs when unset. */
export const DEFAULT_JOB_EXECUTION_CAPABILITY: NormalizedJobExecutionCapability =
  "local-preferred";

/** Default for orphan / unlinked jobs (no cloud scheduling until linked). */
export const UNLINKED_JOB_EXECUTION_CAPABILITY: NormalizedJobExecutionCapability =
  "local-only";

export function defaultExecutionCapabilityForAppIds(
  appIds: readonly string[] | undefined,
  explicit?: JobExecutionCapabilityInput,
): JobExecutionCapability | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (isStandaloneOnly(appIds ?? [STANDALONE_APP_ID])) {
    return UNLINKED_JOB_EXECUTION_CAPABILITY;
  }
  return undefined;
}

/** True when an unset job should be pinned to local-only (standalone or not app-linked). */
export function shouldDefaultUnlinkedJobToLocalOnly(
  job: Pick<JobRecord, "id" | "appIds" | "executionCapability">,
  linkedJobIds: ReadonlySet<string>,
): boolean {
  if (job.executionCapability !== undefined) {
    return false;
  }
  if (isStandaloneOnly(job.appIds ?? [])) {
    return true;
  }
  return !linkedJobIds.has(job.id);
}

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
