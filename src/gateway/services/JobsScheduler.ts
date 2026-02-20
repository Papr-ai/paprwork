import CronParser from "cron-parser";
import { getJobsService, JobsService } from "./JobsService.js";
import type { JobRecord, JobSchedule } from "./jobs/types.js";

let jobsSchedulerInstance: JobsScheduler | null = null;

export class JobsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningLeases: Set<string> = new Set();
  private readonly tickMs = 15_000;

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    void this.tick();
    console.log("[JobsScheduler] Started");
  }

  async tickNow(): Promise<void> {
    await this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    console.log("[JobsScheduler] Stopped");
  }

  private getLeaseKey(jobId: string): string {
    return `schedule:${jobId}`;
  }

  private getCronNextRunAt(cron: string, fromDate: Date): string | undefined {
    try {
      const expression = CronParser.parse(cron, { currentDate: fromDate });
      const next = expression.next().toISOString();
      return next ?? undefined;
    } catch {
      return undefined;
    }
  }

  private shouldRunNow(job: JobRecord, now: Date): boolean {
    const schedule = job.schedule;
    if (!schedule?.enabled) {
      return false;
    }
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      const nextRunAt = job.scheduleState?.nextRunAt;
      if (!nextRunAt) {
        return true;
      }
      return new Date(nextRunAt).getTime() <= now.getTime();
    }
    if (schedule.atTime) {
      const atTimeMs = new Date(schedule.atTime).getTime();
      if (Number.isNaN(atTimeMs)) {
        return false;
      }
      const lastTriggeredAt = job.scheduleState?.lastTriggeredAt;
      if (!lastTriggeredAt) {
        return atTimeMs <= now.getTime();
      }
      return false;
    }
    if (schedule.cron) {
      // Determine base time for next cron calculation
      const lastRun = job.scheduleState?.lastScheduledRunAt
        ? new Date(job.scheduleState.lastScheduledRunAt)
        : undefined;

      const fromDate =
        schedule.catchUpMissed && lastRun
          ? lastRun // Check from last actual run (enables catch-up)
          : new Date(now.getTime() - this.tickMs); // Default: recent window only

      const nextCronAt = this.getCronNextRunAt(schedule.cron, fromDate);
      if (!nextCronAt) {
        return false;
      }
      return new Date(nextCronAt).getTime() <= now.getTime();
    }
    return false;
  }

  private async patchNextRun(
    job: JobRecord,
    schedule: JobSchedule,
    nowIso: string,
  ): Promise<void> {
    const jobsService = getJobsService();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          nextRunAt: new Date(Date.now() + schedule.intervalMs).toISOString(),
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
      const nextRunAt = this.getCronNextRunAt(schedule.cron, new Date());
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          nextRunAt,
          lastTriggeredAt: nowIso,
        },
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async tick(): Promise<void> {
    const jobsService = getJobsService();
    await jobsService.initialize();
    const jobs = await jobsService.listJobs();
    const now = new Date();
    const launches: Array<Promise<void>> = [];
    for (const job of jobs) {
      if (!job.schedule?.enabled) {
        continue;
      }
      const leaseKey = this.getLeaseKey(job.id);
      if (this.runningLeases.has(leaseKey)) {
        continue;
      }
      if (!this.shouldRunNow(job, now)) {
        continue;
      }
      this.runningLeases.add(leaseKey);
      const launch = (async () => {
        const triggeredAt = new Date().toISOString();
        try {
          await jobsService.runJobFromScheduler(job.id, triggeredAt);
          await this.patchNextRun(
            job,
            job.schedule as JobSchedule,
            triggeredAt,
          );
        } catch (error) {
          // Dependency still running — skip this tick silently, it will retry next tick.
          if (error instanceof JobsService.DependencyRunningError) {
            console.log(
              `[JobsScheduler] Skipping ${job.id}: dependency ${error.dependencyId} is still running, will retry next tick`,
            );
          } else {
            console.error(
              `[JobsScheduler] Scheduled run failed for ${job.id}:`,
              error,
            );
          }
        } finally {
          this.runningLeases.delete(leaseKey);
        }
      })();
      launches.push(launch);
    }
    await Promise.all(launches);
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
