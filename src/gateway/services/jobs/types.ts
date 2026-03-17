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
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  name: string;
  type: JobType;
  status: JobStatus;
  /** Free-form folder label for grouping related jobs (e.g. "ingestion", "reporting"). Agent-assigned. */
  folder?: string;
  command?: string;
  requirements?: string[];
  dependsOn?: JobDependency[];
  /** Job IDs this job calls at runtime via /api/jobs/run (for visualization only - not enforced) */
  runtimeCalls?: string[];
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
  /** When status is waiting_permission, lists the API key names awaiting user approval. */
  waitingPermissionKeys?: string[];
}

export interface CreateJobInput {
  name: string;
  type: JobType;
  folder?: string;
  command?: string;
  requirements?: string[];
  dependsOn?: JobDependency[];
  /** Job IDs this job calls at runtime via /api/jobs/run (for visualization - shows dashed arrows in graph) */
  runtimeCalls?: string[];
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
  useCheckpointTemplate?: boolean;
}

// ─── Job Graph ────────────────────────────────────────────────────────────────

export interface JobGraphAppLink {
  name: string;
  jobIds: string[];
}

export interface JobGraphEdge {
  from: string;
  to: string;
  onStatus: "completed" | "failed";
  /** True if this is a runtime call (dashed arrow), false/undefined if dependency (solid arrow) */
  isRuntimeCall?: boolean;
  /** True if the child job auto-triggers when the parent reaches onStatus */
  autoTrigger?: boolean;
}

export interface JobGraph {
  version: 1;
  updatedAt: string;
  /** folder name → job IDs in that folder */
  folders: Record<string, string[]>;
  /** app ID → { name, jobIds } from data-sources.json reverse lookup */
  appLinks: Record<string, JobGraphAppLink>;
  edges: JobGraphEdge[];
}

export interface JobDependency {
  jobId: string;
  onStatus: "completed" | "failed";
  /** When true, this job is automatically triggered when the dependency reaches `onStatus`. */
  autoTrigger?: boolean;
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
