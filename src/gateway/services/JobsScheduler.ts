import { getJobsService, JobsService } from "./JobsService.js";
import type { JobRecord, JobSchedule } from "./jobs/types.js";
import { getGatewayTelemetry } from "./gatewayTelemetry.js";
import {
  computeFollowingNextRunAt,
  computeInitialNextRunAt,
  isScheduleDue,
  msUntilSoonestNextRun,
} from "./jobs/scheduleEngine.js";

let jobsSchedulerInstance: JobsScheduler | null = null;

export class JobsScheduler {
  private static readonly TICK_TELEMETRY_MIN_MS = 300_000;
  private static readonly BACKUP_POLL_MS = 60_000;
  private static readonly WAKE_MIN_MS = 250;

  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private runningLeases: Set<string> = new Set();
  private lastTickTelemetryAt = 0;

  start(): void {
    if (this.backupTimer) {
      return;
    }
    this.backupTimer = setInterval(() => {
      void this.tick();
    }, JobsScheduler.BACKUP_POLL_MS);
    void this.tick();
    console.log("[JobsScheduler] Started (wake + backup poll)");
  }

  /** Call after job schedule mutations so the next `setTimeout` wake is refreshed. */
  requestReschedule(): void {
    void this.tick();
  }

  async tickNow(): Promise<void> {
    await this.tick();
  }

  stop(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    console.log("[JobsScheduler] Stopped");
  }

  private getLeaseKey(jobId: string): string {
    return `schedule:${jobId}`;
  }

  private async patchNextRun(
    job: JobRecord,
    schedule: JobSchedule,
    nowIso: string,
  ): Promise<void> {
    const jobsService = getJobsService();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      const nextRunAt = computeFollowingNextRunAt(schedule, new Date());
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: nowIso,
        },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (schedule.atTime) {
      await jobsService.upsertJob({
        ...job,
        schedule: { ...schedule, enabled: false },
        scheduleState: {
          ...job.scheduleState,
          nextRunAt: undefined,
          lastTriggeredAt: nowIso,
        },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (schedule.cron) {
      const anchor = new Date();
      let nextRunAt = computeFollowingNextRunAt(schedule, anchor);
      if (!nextRunAt) {
        nextRunAt = computeInitialNextRunAt(schedule, anchor, job.scheduleState);
      }
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: nowIso,
        },
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private queueWake(jobs: JobRecord[]): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const nowMs = Date.now();
    const ms = msUntilSoonestNextRun(jobs, nowMs);
    if (ms === null) {
      return;
    }
    const delay =
      ms === 0
        ? JobsScheduler.WAKE_MIN_MS
        : Math.max(ms, JobsScheduler.WAKE_MIN_MS);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    const jobsService = getJobsService();
    await jobsService.initialize();
    let jobs = await jobsService.listJobs();
    const now = new Date();
    const launches: Array<Promise<void>> = [];
    const launchedCount = { value: 0 };
    for (const job of jobs) {
      if (!isScheduleDue(job.schedule, job.scheduleState, now)) {
        continue;
      }
      const dueAt = job.scheduleState?.nextRunAt;
      if (!dueAt) {
        continue;
      }
      const leaseKey = this.getLeaseKey(job.id);
      if (this.runningLeases.has(leaseKey)) {
        continue;
      }
      this.runningLeases.add(leaseKey);
      launchedCount.value += 1;
      const launch = (async () => {
        const triggeredAt = new Date().toISOString();
        try {
          await jobsService.runJobFromScheduler(job.id, dueAt);
          const latest = await jobsService.getJob(job.id);
          if (latest?.schedule?.enabled && latest.schedule) {
            await this.patchNextRun(latest, latest.schedule, triggeredAt);
          }
          const sched = job.schedule as JobSchedule;
          const scheduleType = sched.cron
            ? "cron"
            : sched.intervalMs
              ? "interval"
              : sched.atTime
                ? "atTime"
                : "unknown";
          getGatewayTelemetry().trackFireAndForget(
            "paprwork_scheduler_job_triggered",
            {
              job_id: job.id,
              schedule_type: scheduleType,
            },
          );
        } catch (error) {
          if (error instanceof JobsService.DependencyRunningError) {
            console.log(
              `[JobsScheduler] Skipping ${job.id}: dependency ${error.dependencyId} is still running, will retry next tick`,
            );
          } else {
            console.error(
              `[JobsScheduler] Scheduled run failed for ${job.id}:`,
              error,
            );
            const err =
              error instanceof Error ? error : new Error(String(error));
            getGatewayTelemetry().trackFireAndForget(
              "paprwork_scheduler_job_failed",
              {
                job_id: job.id,
                error_type: err.constructor.name,
              },
            );
          }
        } finally {
          this.runningLeases.delete(leaseKey);
        }
      })();
      launches.push(launch);
    }
    await Promise.all(launches);

    jobs = await jobsService.listJobs();
    this.queueWake(jobs);

    const nowMs = Date.now();
    if (
      nowMs - this.lastTickTelemetryAt >= JobsScheduler.TICK_TELEMETRY_MIN_MS &&
      jobs.length > 0
    ) {
      this.lastTickTelemetryAt = nowMs;
      getGatewayTelemetry().trackFireAndForget("paprwork_scheduler_tick", {
        jobs_checked: jobs.length,
        jobs_launched: launchedCount.value,
      });
    }
  }
}

export function getJobsScheduler(): JobsScheduler {
  if (!jobsSchedulerInstance) {
    jobsSchedulerInstance = new JobsScheduler();
  }
  return jobsSchedulerInstance;
}

export function startJobsScheduler(): void {
  const scheduler = getJobsScheduler();
  scheduler.start();
}
