import type { CatalogAutomation } from "../types/catalogAutomation.js";
import {
  formatJobScheduleLabel,
  type JobScheduleLike,
} from "./jobScheduleLabel.js";

export interface CatalogAutomationJobInput {
  name: string;
  type: string;
  appIds: readonly string[];
  dependsOn?: readonly { jobId: string }[];
  schedule?: JobScheduleLike;
}

function isScheduledStandaloneJob(job: CatalogAutomationJobInput): boolean {
  const deps = job.dependsOn ?? [];
  return Boolean(job.schedule?.enabled) && deps.length === 0;
}

function buildCardLine(scheduledJobs: CatalogAutomationJobInput[], scheduleLabel: string): string {
  if (scheduledJobs.length === 1) {
    return `App plus a job that runs ${scheduleLabel}`;
  }
  return `App plus ${scheduledJobs.length} scheduled jobs`;
}

/** Build publish-time catalog automation from jobs linked to an app. */
export function buildCatalogAutomationForApp(
  appId: string,
  jobs: readonly CatalogAutomationJobInput[],
): CatalogAutomation | null {
  const scheduled = jobs
    .filter((job) => job.appIds.includes(appId) && isScheduledStandaloneJob(job))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (scheduled.length === 0) {
    return null;
  }

  const primary = scheduled[0];
  const scheduleLabel = formatJobScheduleLabel(primary.schedule);
  if (!scheduleLabel) {
    return null;
  }

  const hasAgentJob = scheduled.some((job) => job.type === "agent" || job.type === "subagent");

  return {
    scheduleLabel,
    scheduledJobCount: scheduled.length,
    hasAgentJob,
    cardLine: buildCardLine(scheduled, scheduleLabel),
  };
}
