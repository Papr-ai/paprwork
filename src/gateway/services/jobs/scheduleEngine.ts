import { CronExpressionParser } from "cron-parser";
import type {
  JobExecutionCapability,
  JobSchedule,
  JobScheduleState,
  JobStatus,
} from "./types.js";

type CronParseOptions = {
  currentDate: Date;
  tz?: string;
};

function parseCron(cron: string, options: CronParseOptions) {
  const { currentDate, tz } = options;
  if (tz) {
    return CronExpressionParser.parse(cron, { currentDate, tz });
  }
  return CronExpressionParser.parse(cron, { currentDate });
}

/** Next cron fire strictly after `fromDate`. */
export function getCronNextIsoAfter(
  cron: string,
  fromDate: Date,
  timezone?: string,
): string | undefined {
  try {
    const expression = parseCron(cron, {
      currentDate: fromDate,
      ...(timezone ? { tz: timezone } : {}),
    });
    return expression.next().toDate().toISOString();
  } catch {
    return undefined;
  }
}

/** First scheduled time at or after `earliest` (anchor ~1s in the past to include boundary ticks). */
export function getCronNextIsoOnOrAfter(
  cron: string,
  earliest: Date,
  timezone?: string,
): string | undefined {
  const from = new Date(earliest.getTime() - 1000);
  return getCronNextIsoAfter(cron, from, timezone);
}

/**
 * When persisting a new or edited schedule, compute the first `nextRunAt`.
 */
export function computeInitialNextRunAt(
  schedule: JobSchedule,
  now: Date,
  _previous?: JobScheduleState,
): string | undefined {
  if (!schedule.enabled) {
    return undefined;
  }
  if (schedule.intervalMs && schedule.intervalMs > 0) {
    return new Date(now.getTime() + schedule.intervalMs).toISOString();
  }
  if (schedule.atTime) {
    const at = new Date(schedule.atTime).getTime();
    if (Number.isNaN(at)) {
      return undefined;
    }
    return new Date(at).toISOString();
  }
  if (schedule.cron) {
    return getCronNextIsoOnOrAfter(schedule.cron, now, schedule.timezone);
  }
  return undefined;
}

/**
 * After a run completes (or when skipping missed fires), compute the following `nextRunAt`.
 */
export function computeFollowingNextRunAt(
  schedule: JobSchedule,
  anchor: Date,
): string | undefined {
  if (!schedule.enabled) {
    return undefined;
  }
  if (schedule.intervalMs && schedule.intervalMs > 0) {
    return new Date(anchor.getTime() + schedule.intervalMs).toISOString();
  }
  if (schedule.atTime) {
    return undefined;
  }
  if (schedule.cron) {
    return getCronNextIsoAfter(schedule.cron, anchor, schedule.timezone);
  }
  return undefined;
}

/**
 * When `nextRunAt` is in the past and catch-up is disabled, jump to the next future slot.
 */
export function computeMisfireSkipNextRunAt(
  schedule: JobSchedule,
  now: Date,
): string | undefined {
  if (!schedule.enabled) {
    return undefined;
  }
  if (schedule.intervalMs && schedule.intervalMs > 0) {
    return new Date(now.getTime() + schedule.intervalMs).toISOString();
  }
  if (schedule.atTime) {
    return undefined;
  }
  if (schedule.cron) {
    return getCronNextIsoOnOrAfter(schedule.cron, now, schedule.timezone);
  }
  return undefined;
}

/** Simple due check: `nextRunAt` has arrived (and schedule is enabled). */
export function isScheduleDue(
  schedule: JobSchedule | undefined,
  scheduleState: JobScheduleState | undefined,
  now: Date,
): boolean {
  if (!schedule?.enabled) {
    return false;
  }
  const nextRunAt = scheduleState?.nextRunAt;
  if (!nextRunAt) {
    return false;
  }
  const t = new Date(nextRunAt).getTime();
  if (Number.isNaN(t)) {
    return false;
  }
  return t <= now.getTime();
}

/**
 * Milliseconds until the soonest enabled job’s `nextRunAt` in the future, or `0` if any are due now.
 * Returns `null` if no upcoming runs.
 */
export function msUntilSoonestNextRun(
  jobs: Iterable<{
    id: string;
    schedule?: JobSchedule;
    scheduleState?: JobScheduleState;
    status?: JobStatus;
    executionCapability?: JobExecutionCapability;
  }>,
  nowMs: number,
  activeLeasesPrefix: Set<string> = new Set(),
  skipDueJob?: (job: {
    id: string;
    executionCapability?: JobExecutionCapability;
  }) => boolean,
): number | null {
  let minFuture: number | null = null;
  for (const job of jobs) {
    if (!job.schedule?.enabled) {
      continue;
    }
    if (job.status === "running" || job.status === "waiting_permission") {
      continue;
    }
    // Skip jobs with active scheduler leases
    const leaseKey = `schedule:${job.id}`;
    if (activeLeasesPrefix.has(leaseKey)) {
      continue;
    }
    if (skipDueJob?.(job)) {
      continue;
    }
    const raw = job.scheduleState?.nextRunAt;
    if (!raw) {
      continue;
    }
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) {
      continue;
    }
    const delta = t - nowMs;
    if (delta <= 0) {
      return 0;
    }
    if (minFuture === null || delta < minFuture) {
      minFuture = delta;
    }
  }
  return minFuture;
}
