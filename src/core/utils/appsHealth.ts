/**
 * Per-app job health for the Apps library cards.
 *
 * Built from job records the jobs service already keeps in memory — no log or
 * job-database reads — so the whole library costs one cheap request instead of
 * one per card.
 */
import {
  formatJobScheduleLabel,
  type JobScheduleLike,
} from "./jobScheduleLabel.js";

export interface AppsHealthJobInput {
  id: string;
  name: string;
  appIds?: readonly string[];
  status: string;
  schedule?: JobScheduleLike;
  lastRunAt?: string;
  completedAt?: string;
  error?: string;
  scheduleState?: { nextRunAt?: string; consecutivePermanentFailures?: number };
}

export type AppHealthState = "ok" | "failed" | "running" | "never_run";

export interface AppHealth {
  jobCount: number;
  /** Human schedule of the first scheduled job, e.g. "daily at 9 am". */
  scheduleLabel: string | null;
  scheduledJobCount: number;
  state: AppHealthState;
  /** Most recent run across the app's jobs (ISO). */
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Set when state is "failed": the job that failed and its stored error. */
  failingJobName: string | null;
  failingJobId: string | null;
  error: string | null;
  /** Consecutive permanent failures on the failing job (0 when unknown). */
  failureStreak: number;
}

export type AppsHealthMap = Record<string, AppHealth>;

const MAX_ERROR_CHARS = 160;

function latest(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function earliest(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function shortError(error: string | undefined): string | null {
  const line = error
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  return line.length > MAX_ERROR_CHARS
    ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…`
    : line;
}

function emptyHealth(): AppHealth {
  return {
    jobCount: 0,
    scheduleLabel: null,
    scheduledJobCount: 0,
    state: "never_run",
    lastRunAt: null,
    nextRunAt: null,
    failingJobName: null,
    failingJobId: null,
    error: null,
    failureStreak: 0,
  };
}

/** Group jobs by app id. Failure beats running beats ok beats never run. */
export function buildAppsHealth(
  jobs: readonly AppsHealthJobInput[],
): AppsHealthMap {
  const map: AppsHealthMap = {};
  const sorted = [...jobs].sort((a, b) => a.name.localeCompare(b.name));
  for (const job of sorted) {
    for (const appId of job.appIds ?? []) {
      const h = (map[appId] ??= emptyHealth());
      h.jobCount += 1;
      const label = formatJobScheduleLabel(job.schedule);
      if (label) {
        h.scheduledJobCount += 1;
        h.scheduleLabel ??= label;
        h.nextRunAt = earliest(h.nextRunAt, job.scheduleState?.nextRunAt);
      }
      h.lastRunAt = latest(h.lastRunAt, job.lastRunAt ?? job.completedAt);

      if (job.status === "failed") {
        if (h.state !== "failed") {
          h.state = "failed";
          h.failingJobName = job.name;
          h.failingJobId = job.id;
          h.error = shortError(job.error);
          h.failureStreak =
            job.scheduleState?.consecutivePermanentFailures ?? 0;
        }
      } else if (
        job.status === "running" ||
        job.status === "waiting_permission"
      ) {
        if (h.state !== "failed") h.state = "running";
      } else if (job.status === "completed" && h.state === "never_run") {
        h.state = "ok";
      }
    }
  }
  return map;
}
