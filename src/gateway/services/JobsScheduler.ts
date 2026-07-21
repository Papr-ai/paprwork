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
  private static readonly BACKUP_POLL_MS = 60_000;
  private static readonly WAKE_MIN_MS = 250;

  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private runningLeases: Set<string> = new Set();

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
    scheduledDueAt: string,
    triggeredAt: string,
  ): Promise<void> {
    const jobsService = getJobsService();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      // Use the scheduled due time as anchor for consistent intervals
      const anchor = new Date(scheduledDueAt);
      const nextRunAt = computeFollowingNextRunAt(schedule, anchor);
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: triggeredAt,
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
          lastTriggeredAt: triggeredAt,
        },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (schedule.cron) {
      // Use the scheduled due time as anchor for cron
      const anchor = new Date(scheduledDueAt);
      let nextRunAt = computeFollowingNextRunAt(schedule, anchor);
      if (!nextRunAt) {
        nextRunAt = computeInitialNextRunAt(schedule, anchor, job.scheduleState);
      }
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: triggeredAt,
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
    const ms = msUntilSoonestNextRun(jobs, nowMs, this.runningLeases);
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
    const tickStart = Date.now();
    const jobsService = getJobsService();
    await jobsService.initialize();
    
    console.log(`[JobsScheduler] Tick started at ${new Date().toISOString()}`);
    await jobsService.reconcileStaleRunningJobs();
    
    let jobs = await jobsService.listJobs();
    console.log(`[JobsScheduler] Checking ${jobs.length} total jobs`);
    
    const now = new Date();
    const launches: Array<Promise<void>> = [];
    const launchedCount = { value: 0 };
    let enabledCount = 0;
    let dueCount = 0;
    let skippedRunning = 0;
    
    for (const job of jobs) {
      if (!job.schedule?.enabled) {
        continue;
      }
      enabledCount++;
      
      if (!isScheduleDue(job.schedule, job.scheduleState, now)) {
        continue;
      }
      dueCount++;
      
      if (job.status === "running" || job.status === "waiting_permission") {
        //console.log(`[JobsScheduler] Skipping job ${job.id} (${job.name}) - status: ${job.status}`);
        skippedRunning++;
        continue;
      }
      
      const dueAt = job.scheduleState?.nextRunAt;
      if (!dueAt) {
        //console.log(`[JobsScheduler] Skipping job ${job.id} (${job.name}) - no nextRunAt`);
        continue;
      }
      const leaseKey = this.getLeaseKey(job.id);
      if (this.runningLeases.has(leaseKey)) {
        //console.log(`[JobsScheduler] Skipping job ${job.id} (${job.name}) - already has lease`);
        continue;
      }
      
      //console.log(`[JobsScheduler] Launching job ${job.id} (${job.name}) for slot ${dueAt}`);
      this.runningLeases.add(leaseKey);
      launchedCount.value += 1;
      const launch = (async () => {
        const triggeredAt = new Date().toISOString();
        try {
          await jobsService.runJobFromScheduler(job.id, dueAt);
          const latest = await jobsService.getJob(job.id);
          if (latest?.schedule?.enabled && latest.schedule) {
            await this.patchNextRun(latest, latest.schedule, dueAt, triggeredAt);
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
            const isArchitectureValidationFailure = err.message.includes(
              "Job architecture validation failed",
            );
            if (isArchitectureValidationFailure) {
              const latest = await jobsService.getJob(job.id);
              if (latest?.schedule?.enabled && latest.schedule) {
                await this.patchNextRun(
                  latest,
                  latest.schedule,
                  dueAt,
                  triggeredAt,
                );
              }
              console.warn(
                `[JobsScheduler] Advanced next run for ${job.id} after architecture validation failure`,
              );
            }
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

    const elapsed = Date.now() - tickStart;
    console.log(
      `[JobsScheduler] Tick completed in ${elapsed}ms - ` +
      `enabled: ${enabledCount}, due: ${dueCount}, launched: ${launchedCount.value}, ` +
      `skipped: ${skippedRunning}`
    );

    // Note: Removed paprwork_scheduler_tick telemetry - too noisy for Amplitude
    // Scheduler health should be monitored via logs, not user analytics
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
