import { CronExpressionParser } from "cron-parser";
import type { JobSchedule, JobType } from "./types.js";

/** Agent schedules at or below this interval require explicit user approval before running. */
export const AGENT_SCHEDULE_APPROVAL_MAX_MS = 30 * 60 * 1000;

/** Agent schedules below this interval show a softer warning (still allowed without approval). */
export const AGENT_SCHEDULE_WARNING_MAX_MS = 60 * 60 * 1000;

export type AgentScheduleRiskLevel = "ok" | "warning" | "approval_required";

export interface AgentScheduleAssessment {
  level: AgentScheduleRiskLevel;
  intervalMs?: number;
  intervalMinutes?: number;
  runsPerDay?: number;
  message?: string;
}

/**
 * Estimate the shortest gap between consecutive scheduled fires.
 * Returns null for one-shot atTime schedules or unparseable cron.
 */
export function estimateScheduleIntervalMs(
  schedule: JobSchedule,
): number | null {
  if (!schedule.enabled) {
    return null;
  }
  if (schedule.intervalMs && schedule.intervalMs > 0) {
    return schedule.intervalMs;
  }
  if (schedule.cron) {
    try {
      const now = new Date();
      const expression = CronExpressionParser.parse(schedule.cron, {
        currentDate: now,
        ...(schedule.timezone ? { tz: schedule.timezone } : {}),
      });
      const first = expression.next().toDate();
      const second = expression.next().toDate();
      return second.getTime() - first.getTime();
    } catch {
      return null;
    }
  }
  return null;
}

export function formatAgentScheduleRunsPerDay(intervalMs: number): string {
  const runs = Math.round((24 * 60 * 60 * 1000) / intervalMs);
  return `~${runs}`;
}

export function assessAgentJobSchedule(
  type: JobType,
  schedule: JobSchedule | undefined,
): AgentScheduleAssessment {
  if (type !== "agent" && type !== "subagent") {
    return { level: "ok" };
  }
  if (!schedule?.enabled) {
    return { level: "ok" };
  }

  const intervalMs = estimateScheduleIntervalMs(schedule);
  if (intervalMs === null) {
    return { level: "ok" };
  }

  const intervalMinutes = Math.max(1, Math.round(intervalMs / 60_000));
  const runsPerDay = Number.parseInt(
    formatAgentScheduleRunsPerDay(intervalMs),
    10,
  );

  if (intervalMs <= AGENT_SCHEDULE_APPROVAL_MAX_MS) {
    return {
      level: "approval_required",
      intervalMs,
      intervalMinutes,
      runsPerDay,
      message:
        `This agent job runs every ~${intervalMinutes} min (${runsPerDay} runs/day). ` +
        `Each run can use ~100K+ input tokens via OAuth. Approve before the schedule runs automatically.`,
    };
  }

  if (intervalMs < AGENT_SCHEDULE_WARNING_MAX_MS) {
    return {
      level: "warning",
      intervalMs,
      intervalMinutes,
      runsPerDay,
      message:
        `Agent job scheduled every ~${intervalMinutes} min (${runsPerDay} runs/day). ` +
        `Agent runs are token-heavy — consider hourly/daily for recurring AI work, or use python/node for frequent sync.`,
    };
  }

  return { level: "ok", intervalMs, intervalMinutes, runsPerDay };
}

/** @deprecated Use assessAgentJobSchedule — kept for tests migrating from validateAgentJobSchedule */
export function validateAgentJobSchedule(
  type: JobType,
  schedule: JobSchedule | undefined,
): { ok: boolean; message?: string; intervalMs?: number } {
  const assessment = assessAgentJobSchedule(type, schedule);
  if (assessment.level === "approval_required") {
    return {
      ok: false,
      message: assessment.message,
      intervalMs: assessment.intervalMs,
    };
  }
  return { ok: true, intervalMs: assessment.intervalMs };
}

export function requiresScheduleRiskAcknowledgment(
  type: JobType,
  schedule: JobSchedule | undefined,
): boolean {
  const assessment = assessAgentJobSchedule(type, schedule);
  if (assessment.level !== "approval_required") {
    return false;
  }
  return !schedule?.highFrequencyAcknowledgedAt;
}
