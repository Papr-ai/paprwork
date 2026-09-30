/**
 * In-memory index of enabled scheduled jobs by nextRunAt.
 * Derived from JobRecord — rebuildable from this.jobs at any time.
 */

import { isWorkspaceChatJob } from "../../../core/constants/workspaceChatJob.js";
import type { JobRecord } from "./types.js";
import { isScheduleDue } from "./scheduleEngine.js";

export class JobScheduleIndex {
  /** Enabled schedules with a valid nextRunAt (ms since epoch). */
  private byNextRunMs = new Map<string, number>();

  syncJob(job: JobRecord): void {
    if (isWorkspaceChatJob(job.id)) {
      this.remove(job.id);
      return;
    }
    if (!job.schedule?.enabled) {
      this.remove(job.id);
      return;
    }
    const raw = job.scheduleState?.nextRunAt;
    if (!raw) {
      this.remove(job.id);
      return;
    }
    const nextRunAtMs = new Date(raw).getTime();
    if (Number.isNaN(nextRunAtMs)) {
      this.remove(job.id);
      return;
    }
    this.byNextRunMs.set(job.id, nextRunAtMs);
  }

  remove(jobId: string): void {
    this.byNextRunMs.delete(jobId);
  }

  rebuildFromJobs(jobs: Iterable<JobRecord>): void {
    this.byNextRunMs.clear();
    for (const job of jobs) {
      this.syncJob(job);
    }
  }

  /** Job ids whose nextRunAt has arrived (enabled + valid nextRunAt only). */
  getDueJobIds(nowMs: number): string[] {
    const due: string[] = [];
    for (const [jobId, nextRunAtMs] of this.byNextRunMs) {
      if (nextRunAtMs <= nowMs) {
        due.push(jobId);
      }
    }
    return due;
  }

  getScheduledJobIds(): string[] {
    return [...this.byNextRunMs.keys()];
  }

  scheduledCount(): number {
    return this.byNextRunMs.size;
  }
}

/** Brute-force due set — oracle for tests and optional dev assertions. */
export function bruteForceDueJobIds(
  jobs: Iterable<JobRecord>,
  nowMs: number,
): string[] {
  const now = new Date(nowMs);
  const ids: string[] = [];
  for (const job of jobs) {
    if (isWorkspaceChatJob(job.id)) {
      continue;
    }
    if (isScheduleDue(job.schedule, job.scheduleState, now)) {
      ids.push(job.id);
    }
  }
  ids.sort();
  return ids;
}

export function sortedJobIds(ids: string[]): string[] {
  return [...ids].sort();
}
