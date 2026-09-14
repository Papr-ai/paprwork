import { classifyError } from "./errorClassifier.js";
import type { JobRecord, JobSchedule, JobScheduleState } from "./types.js";

/**
 * Permanent failures in a row before scheduling is switched off.
 *
 * Not one, because the two mistakes are not symmetric: parking a healthy job
 * stops work the user asked for, while leaving a broken one scheduled only
 * costs a failed slot and a log line. So require corroboration before acting.
 */
export const MAX_CONSECUTIVE_PERMANENT_FAILURES = 3;

/**
 * A linked file that exists and opens but is not a readable SQLite database.
 *
 * `new Database(path)` only takes a file handle — SQLite does not read the
 * header until the first statement — so a truncated or overwritten file opens
 * fine and then throws from `prepare()`. Nothing about waiting changes that.
 *
 * Exported because JobsScheduler logs a database-specific remediation for this
 * case and reports it on the failure telemetry. It must be the same predicate
 * that decides permanence, or the log and the decision can disagree.
 */
export function isUnusableDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    (error as { code?: unknown } | null | undefined)?.code ===
      "SQLITE_NOTADB" ||
    /file is not a database|database disk image is malformed|malformed database schema/i.test(
      message,
    )
  );
}

/**
 * Whether retrying this job later could plausibly produce a different result.
 *
 * The single permanence rule for a failed scheduled run. There were three
 * readings of this question before — the scheduler's inline `isUnusableDatabase`
 * (used only for logging), a mirrored copy in the retry-storm test, and
 * `classifyError` — and they disagreed, which is how the case below was missed.
 *
 * Two families are permanent for reasons stronger than a string match:
 *
 *  - **Pre-run architecture validation.** The run never started, so its inputs
 *    (the job's config and the database registry) are exactly what they were,
 *    and identical inputs produce the identical refusal.
 *  - **An unusable database file.** A corrupt file does not heal on a timer.
 *
 * Both have to be named here because `classifyError` calls them *transient*:
 * its permanent list looks for "validation error" while the message reads
 * "validation failed", it has no notion of SQLite at all, and anything
 * unmatched falls through to transient. Deferring to it alone would leave the
 * two failures that cannot possibly succeed retrying forever.
 */
export function isPermanentJobRunFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/job architecture validation failed/i.test(message)) {
    return true;
  }
  if (isUnusableDatabaseError(error)) {
    return true;
  }
  return classifyError(error) === "permanent";
}

export type ScheduleFailureOutcome =
  | { kind: "advance"; consecutivePermanentFailures: number }
  | { kind: "park"; consecutivePermanentFailures: number; reason: string };

/**
 * Decide what a failed scheduled run should do to the schedule.
 *
 * A transient failure leaves the streak untouched rather than resetting it: it
 * is evidence about the network, not about whether the job is configured
 * correctly, so it should neither confirm a misconfiguration nor clear one.
 * Only a run that got far enough to launch clears the streak — see
 * `clearPermanentFailureStreak`.
 */
export function resolveScheduleFailureOutcome(
  scheduleState: JobScheduleState | undefined,
  error: unknown,
): ScheduleFailureOutcome {
  const previous = scheduleState?.consecutivePermanentFailures ?? 0;

  if (!isPermanentJobRunFailure(error)) {
    return { kind: "advance", consecutivePermanentFailures: previous };
  }

  const streak = previous + 1;
  if (streak < MAX_CONSECUTIVE_PERMANENT_FAILURES) {
    return { kind: "advance", consecutivePermanentFailures: streak };
  }

  const detail = (error instanceof Error ? error.message : String(error ?? ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join(" ");

  return {
    kind: "park",
    consecutivePermanentFailures: streak,
    reason:
      `Scheduling paused after ${streak} runs that failed for a reason retrying ` +
      `cannot fix. Re-enable the schedule once it is resolved. Last error: ${detail}`,
  };
}

/**
 * The record a parked job should be saved as.
 *
 * Kept here beside the decision rather than inline at the call site so the
 * consequence is testable without a scheduler, a JobsService or a database —
 * "should we park" and "what does parked look like" are both rules, and only
 * the save is I/O.
 *
 * `nextRunAt` is cleared as well as `enabled` being set false. Leaving a due
 * timestamp behind on a disabled schedule would make the job fire immediately
 * on whatever re-enables it, which is the loop this exists to end.
 */
export function buildParkedJobPatch(
  job: JobRecord & { schedule: JobSchedule },
  outcome: Extract<ScheduleFailureOutcome, { kind: "park" }>,
  triggeredAt: string,
  now: string,
): JobRecord {
  return {
    ...job,
    schedule: { ...job.schedule, enabled: false },
    scheduleState: {
      ...job.scheduleState,
      nextRunAt: undefined,
      lastTriggeredAt: triggeredAt,
      consecutivePermanentFailures: outcome.consecutivePermanentFailures,
      parkedReason: outcome.reason,
      parkedAt: now,
    },
    error: outcome.reason,
    updatedAt: now,
  };
}

/**
 * A run that got past validation clears the streak.
 *
 * Returned as a patch of explicit `undefined`s rather than an object with the
 * keys removed, because the caller merges this over the carried-forward state:
 * an absent key would leave the old streak in place, which is the opposite of
 * clearing it.
 */
export function clearPermanentFailureStreak(): Partial<JobScheduleState> {
  return {
    consecutivePermanentFailures: undefined,
    parkedReason: undefined,
    parkedAt: undefined,
  };
}
