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
  /** Mini-app UUIDs this job belongs to (from list_apps). At least one required on create. */
  appIds: string[];
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
  /** Provider for agent/subagent jobs (e.g. "openai", "anthropic", "ollama"). Overrides default. */
  provider?: string;
  /** Model ID for agent/subagent jobs (e.g. "gpt-5.4", "claude-sonnet-4-5"). Overrides default. */
  model?: string;
  /** Execution recipe configuration — enables quality evaluation of runs */
  recipe?: RecipeConfig;
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
  /** Latest recipe evaluation result (summary — full results in evaluations/ dir) */
  lastEvaluation?: RecipeEvaluationSummary;
}

export interface CreateJobInput {
  name: string;
  type: JobType;
  /** Mini-app UUID(s) this job belongs to. Required — use ['__standalone__'] for orphan jobs. */
  appIds: string[];
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
  /** Provider for agent/subagent jobs (e.g. "openai", "anthropic", "ollama"). Overrides default. */
  provider?: string;
  /** Model ID for agent/subagent jobs (e.g. "gpt-5.4", "claude-sonnet-4-5"). Overrides default. */
  model?: string;
  /** Execution recipe configuration — enables quality evaluation of runs */
  recipe?: RecipeConfig;
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
  /** app ID → { name, jobIds } from job.appIds (+ data-sources fallback) */
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
  /** IANA timezone for cron evaluation (e.g. "America/Los_Angeles"). Omit for local default behavior. */
  timezone?: string;
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

// ─── Execution Recipes ───────────────────────────────────────────────────────

/** Configuration for a job's execution recipe (stored in job.json) */
export interface RecipeConfig {
  /** Whether the recipe is active and should be used for evaluation */
  enabled: boolean;
  /** Automatically evaluate runs against the recipe on completion */
  autoEvaluate?: boolean;
  /** Minimum overall score (0-1) to consider a run as passing */
  passThreshold?: number;
  /** Provider for the evaluator agent (defaults to job's provider or system default) */
  evaluatorProvider?: string;
  /** Model for the evaluator agent (defaults to job's model or system default) */
  evaluatorModel?: string;
}

/** Compact evaluation summary stored on the job record */
export interface RecipeEvaluationSummary {
  runId: string;
  score: number;
  passed: boolean;
  timestamp: string;
}

/** A single criterion evaluation result */
export interface RecipeEvalCriterion {
  name: string;
  score: number;
  weight: number;
  passed: boolean;
  notes: string;
}

/** Full evaluation result for a single run */
export interface RecipeEvaluation {
  runId: string;
  jobId: string;
  timestamp: string;
  overallScore: number;
  passed: boolean;
  criteria: RecipeEvalCriterion[];
  summary: string;
  antiPatternViolations: string[];
  edgeCasesHandled: string[];
  evaluatorModel: string;
  durationMs: number;
}
