export type JobType =
  | "shell"
  | "bash"
  | "node"
  | "python"
  | "swift"
  | "agent"
  | "subagent";

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  name: string;
  type: JobType;
  status: JobStatus;
  command?: string;
  requirements?: string[];
  dependsOn?: JobDependency[];
  retries?: JobRetryPolicy;
  deliver?: JobDelivery;
  retentionDays?: number;
  schedule?: JobSchedule;
  scheduleState?: JobScheduleState;
  subAgentId?: string;
  delegatedBy?: string;
  delegationTask?: string;
  delegationContext?: string;
  outputMode?: JobOutputMode;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: JobMemoryPolicy;
  reportChatId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  // Execution tracking enhancements
  currentExecutionId?: string;
  lastExecutionId?: string;
  currentAttempt?: number;
  maxAttempts?: number;
  nextRetryAt?: string;
  /** Captured stdout from the last completed run (capped at 32KB). Available via WebSocket and wait:true response. */
  lastOutput?: string;
}

export interface CreateJobInput {
  name: string;
  type: JobType;
  command?: string;
  requirements?: string[];
  dependsOn?: JobDependency[];
  retries?: JobRetryPolicy;
  deliver?: JobDelivery;
  retentionDays?: number;
  schedule?: JobSchedule;
  subAgentId?: string;
  delegatedBy?: string;
  delegationTask?: string;
  delegationContext?: string;
  outputMode?: JobOutputMode;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: JobMemoryPolicy;
  reportChatId?: string;
}

export interface JobDependency {
  jobId: string;
  onStatus: "completed" | "failed";
}

export interface JobRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface JobDelivery {
  channel: "chat";
  targetId: string;
}

export type JobOutputMode = "natural" | "structured";
export type JobMemoryPolicy = "none" | "summary" | "full";

export interface JobSchedule {
  enabled: boolean;
  cron?: string;
  intervalMs?: number;
  atTime?: string;
  catchUpMissed?: boolean;
}

export interface JobScheduleState {
  nextRunAt?: string;
  lastScheduledRunAt?: string;
  lastTriggeredAt?: string;
  // Idempotency tracking for scheduled runs
  currentIdempotencyKey?: string;
  lastIdempotencyKey?: string;
}
