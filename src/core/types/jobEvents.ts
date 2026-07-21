/**
 * Job event types for mini-app push updates (SSE + WebSocket).
 *
 * Jobs emit structured progress by printing a line to stdout:
 *   PAPR_PROGRESS {"event":"score_count","payload":{"sourceId":5,"count":12}}
 */

export type JobEventType =
  | "jobs:status-changed"
  | "jobs:progress"
  | "jobs:log-line"
  | "jobs:db-changed";

export interface JobStatusChangedData {
  jobId: string;
  name?: string;
  status: string;
  completedAt?: string;
  error?: string;
  lastOutput?: string;
  waitingPermissionKeys?: string[];
  waitingScheduleRisk?: {
    intervalMinutes: number;
    runsPerDay: number;
    message: string;
  };
}

export interface JobProgressData {
  jobId: string;
  /** Event name, e.g. "score_count", "batch_done" */
  event: string;
  payload: Record<string, unknown>;
}

export interface JobLogLineData {
  jobId: string;
  line: string;
}

export interface DbChangedData {
  jobId?: string;
  dbId?: string;
  /** Table names that changed (empty = unknown, refetch all). */
  tables: string[];
}

export type JobEventData =
  | JobStatusChangedData
  | JobProgressData
  | JobLogLineData
  | DbChangedData;

export interface JobEvent {
  type: JobEventType;
  data: JobEventData;
}

export function jobEventJobId(event: JobEvent): string | undefined {
  if ("jobId" in event.data && typeof event.data.jobId === "string") {
    return event.data.jobId;
  }
  return undefined;
}

export function jobEventDbId(event: JobEvent): string | undefined {
  if (event.type === "jobs:db-changed" && "dbId" in event.data) {
    const dbId = event.data.dbId;
    return typeof dbId === "string" ? dbId : undefined;
  }
  return undefined;
}

export const PAPR_PROGRESS_PREFIX = "PAPR_PROGRESS ";
