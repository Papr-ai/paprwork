import { getJobsService, JobsService } from "./JobsService.js";
import type {
  JobRecord,
  JobSchedule,
  JobScheduleState,
} from "./jobs/types.js";
import { getGatewayTelemetry } from "./gatewayTelemetry.js";
import {
  computeInitialNextRunAt,
  computeNextRunAtAfterSlot,
  msUntilSoonestNextRun,
} from "./jobs/scheduleEngine.js";
import {
  isCloudSchedulerAuthoritative,
  isJobDeferredToCloudScheduler,
  shouldDesktopSchedulerRunJob,
} from "../utils/cloudSchedulerAuthority.js";
import {
  releaseSchedulerRunLease,
  tryAcquireSchedulerRunLease,
} from "./jobs/jobSchedulerRunLease.js";
import {
  buildParkedJobPatch,
  clearPermanentFailureStreak,
  isUnusableDatabaseError,
  resolveScheduleFailureOutcome,
} from "./jobs/schedulePark.js";
import { PhaseTimer } from "../utils/phaseTiming.js";

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
    /** Merged over the carried-forward schedule state (failure streak, etc.). */
    scheduleStatePatch: Partial<JobScheduleState> = {},
  ): Promise<void> {
    const jobsService = getJobsService();
    const now = new Date();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      // Anchor on the scheduled due time, not on now, so intervals stay on
      // their grid — but step far enough to land in the future (see
      // computeNextRunAtAfterSlot).
      const anchor = new Date(scheduledDueAt);
      const nextRunAt = computeNextRunAtAfterSlot(schedule, anchor, now);
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: triggeredAt,
          ...scheduleStatePatch,
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
          ...scheduleStatePatch,
        },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (schedule.cron) {
      // Use the scheduled due time as anchor for cron
      const anchor = new Date(scheduledDueAt);
      let nextRunAt = computeNextRunAtAfterSlot(schedule, anchor, now);
      if (!nextRunAt) {
        nextRunAt = computeInitialNextRunAt(schedule, anchor, job.scheduleState);
      }
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          ...job.scheduleState,
          ...(nextRunAt ? { nextRunAt } : {}),
          lastTriggeredAt: triggeredAt,
          ...scheduleStatePatch,
        },
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private queueWake(
    jobs: JobRecord[],
    cloudSchedulerAuthoritative: boolean,
  ): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const nowMs = Date.now();
    const ms = msUntilSoonestNextRun(
      jobs,
      nowMs,
      this.runningLeases,
      (job) => isJobDeferredToCloudScheduler(job, cloudSchedulerAuthoritative),
    );
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
    const timer = new PhaseTimer();
    const { waitForWorkspaceReady } = await import("./workspaceReadiness.js");
    await waitForWorkspaceReady();
    timer.mark("workspaceReady");

    const jobsService = getJobsService();
    await jobsService.initialize();
    timer.mark("jobsInitialize");

    console.log(`[JobsScheduler] Tick started at ${new Date().toISOString()}`);
    await jobsService.reconcileStaleRunningJobs();
    timer.mark("reconcileStale");
    void jobsService.maybePruneStaleJobEntries().catch((err) => {
      console.warn(
        "[JobsScheduler] Stale job prune failed:",
        (err as Error).message.slice(0, 120),
      );
    });

    const registrySize = (await jobsService.listJobs()).length;
    timer.mark("listJobs");

    const now = new Date();
    const dueJobIds = jobsService.getDueScheduledJobIds(now);
    const scheduledEnabled = jobsService.getScheduleIndexScheduledCount();
    console.log(
      `[JobsScheduler] Registry ${registrySize} job(s), ${scheduledEnabled} scheduled-enabled, ${dueJobIds.length} due now`,
    );

    const launches: Array<Promise<void>> = [];
    const launchedCount = { value: 0 };
    let enabledCount = scheduledEnabled;
    let dueCount = dueJobIds.length;
    let skippedRunning = 0;
    let skippedCloudPreferred = 0;
    let skippedRunLease = 0;
    const cloudSchedulerAuthoritative = await isCloudSchedulerAuthoritative();
    timer.mark("cloudSchedulerAuth");

    const scanStarted = performance.now();
    for (const jobId of dueJobIds) {
      const job = await jobsService.getJob(jobId);
      if (!job?.schedule?.enabled) {
        continue;
      }

      if (!shouldDesktopSchedulerRunJob(job, cloudSchedulerAuthoritative)) {
        skippedCloudPreferred++;
        continue;
      }

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

      const runLease = await tryAcquireSchedulerRunLease(job.id, dueAt);
      if (!runLease.acquired) {
        skippedRunLease++;
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
            // Getting this far means the job passed validation and launched,
            // which is the signal that clears any permanent-failure streak.
            await this.patchNextRun(
              latest,
              latest.schedule,
              dueAt,
              triggeredAt,
              clearPermanentFailureStreak(),
            );
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
            // A failed run still consumed its scheduled slot, so nextRunAt must
            // move forward. Leaving it in the past keeps the job permanently due
            // and relaunches it on every tick (several times per second) until
            // someone notices — one job produced 645k failure events in a single
            // week that way. DependencyRunningError is the only legitimate
            // retry-next-tick case and is handled in the branch above; every
            // other error advances the schedule and waits for the next slot.
            // Shared with the park policy rather than re-tested here: the
            // remediation this logs and the decision to stop scheduling have
            // to be about the same set of errors.
            const isUnusableDatabase = isUnusableDatabaseError(error);
            if (isUnusableDatabase) {
              console.error(
                `[JobsScheduler] Job ${job.id} is linked to an unusable database — ` +
                  `re-link or recreate the database.`,
              );
            }
            let scheduleAdvanced = false;
            let parked = false;
            try {
              const latest = await jobsService.getJob(job.id);
              if (latest?.schedule?.enabled && latest.schedule) {
                const outcome = resolveScheduleFailureOutcome(
                  latest.scheduleState,
                  err,
                );
                if (outcome.kind === "park") {
                  // Advancing the slot stops the tick-rate loop but still
                  // burns a run, logs a stack trace, and reports a failure
                  // every interval indefinitely. Once the same
                  // retry-cannot-help error has come back this many times,
                  // scheduling is the thing that is wrong — so stop it and
                  // leave the reason on the record instead of repeating it
                  // forever.
                  await jobsService.upsertJob(
                    buildParkedJobPatch(
                      { ...latest, schedule: latest.schedule },
                      outcome,
                      triggeredAt,
                      new Date().toISOString(),
                    ),
                  );
                  parked = true;
                  console.error(
                    `[JobsScheduler] Paused schedule for ${job.id} (${job.name}): ` +
                      outcome.reason,
                  );
                } else {
                  await this.patchNextRun(
                    latest,
                    latest.schedule,
                    dueAt,
                    triggeredAt,
                    {
                      consecutivePermanentFailures:
                        outcome.consecutivePermanentFailures || undefined,
                    },
                  );
                  scheduleAdvanced = true;
                }
              }
            } catch (patchError) {
              // Never let bookkeeping failure mask the original run failure.
              console.error(
                `[JobsScheduler] Failed to advance next run for ${job.id}:`,
                patchError,
              );
            }
            getGatewayTelemetry().trackFireAndForget(
              "paprwork_scheduler_job_failed",
              {
                job_id: job.id,
                error_type: err.constructor.name,
                schedule_advanced: scheduleAdvanced,
                schedule_parked: parked,
                unusable_database: isUnusableDatabase,
              },
            );
          }
        } finally {
          this.runningLeases.delete(leaseKey);
          if (runLease.runId) {
            await releaseSchedulerRunLease(job.id, dueAt, runLease.runId);
          }
        }
      })();
      launches.push(launch);
    }
    timer.mark(`scanDue(${Math.round(performance.now() - scanStarted)}ms)`);

    await Promise.all(launches);
    timer.mark(`launches(${launchedCount.value})`);

    const wakeJobs = jobsService.getScheduledJobsForWake();
    timer.mark("listJobsAfter");
    this.queueWake(wakeJobs, cloudSchedulerAuthoritative);
    timer.mark("queueWake");

    const elapsed = timer.totalMs();
    console.log(
      `[JobsScheduler] Tick completed in ${elapsed}ms - ` +
        `enabled: ${enabledCount}, due: ${dueCount}, launched: ${launchedCount.value}, ` +
        `skipped: ${skippedRunning}, cloud_deferred: ${skippedCloudPreferred}, lease_contention: ${skippedRunLease}`,
    );
    if (elapsed >= 100) {
      timer.log("JobsScheduler phases");
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
