import { createHash } from "node:crypto";
import type { JobRuntimePatch } from "../../types/cloudRuntime.js";
import type { JobRecord, JobStatus } from "./types.js";

/** Git-tracked job definition fields (aligned with BundleService export keep list). */
export const JOB_CONFIG_FIELD_KEYS = [
  "id",
  "name",
  "type",
  "appIds",
  "writeDbIds",
  "folder",
  "command",
  "requirements",
  "dependsOn",
  "runtimeCalls",
  "retries",
  "deliver",
  "retentionDays",
  "schedule",
  "subAgentId",
  "delegatedBy",
  "delegationTask",
  "delegationContext",
  "outputMode",
  "outputSchema",
  "maxTurns",
  "memoryPolicy",
  "reportChatId",
  "provider",
  "model",
  "recipe",
  "createdAt",
] as const satisfies readonly (keyof JobRecord)[];

/** Local / memory-only runtime fields — never committed to git. */
export const JOB_RUNTIME_FIELD_KEYS = [
  "status",
  "updatedAt",
  "lastRunAt",
  "completedAt",
  "exitCode",
  "error",
  "currentExecutionId",
  "lastExecutionId",
  "currentAttempt",
  "maxAttempts",
  "nextRetryAt",
  "lastOutput",
  "waitingPermissionKeys",
  "waitingScheduleRisk",
  "lastEvaluation",
  "scheduleState",
] as const satisfies readonly (keyof JobRecord)[];

export type JobConfigSlice = Pick<
  JobRecord,
  (typeof JOB_CONFIG_FIELD_KEYS)[number]
>;

export type JobRuntimeSlice = Pick<
  JobRecord,
  (typeof JOB_RUNTIME_FIELD_KEYS)[number]
>;

const CONFIG_KEY_SET = new Set<string>(JOB_CONFIG_FIELD_KEYS);
const RUNTIME_KEY_SET = new Set<string>(JOB_RUNTIME_FIELD_KEYS);

function pickFields<T extends object>(
  source: T,
  keys: readonly string[],
): Partial<T> {
  const out: Partial<T> = {};
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (key in record && record[key] !== undefined) {
      (out as Record<string, unknown>)[key] = record[key];
    }
  }
  return out;
}

export function defaultJobRuntime(createdAt: string): JobRuntimeSlice {
  return {
    status: "pending",
    updatedAt: createdAt,
  };
}

/** Split a merged job record into config (git) + runtime (local) slices. */
export function splitJobRecord(record: JobRecord): {
  config: JobConfigSlice;
  runtime: JobRuntimeSlice;
} {
  const config = pickFields(record, JOB_CONFIG_FIELD_KEYS) as JobConfigSlice;
  const runtime = {
    ...defaultJobRuntime(record.createdAt),
    ...pickFields(record, JOB_RUNTIME_FIELD_KEYS),
  } as JobRuntimeSlice;
  return { config, runtime };
}

/** Merge config + runtime into a full in-memory JobRecord. */
export function mergeJobConfigAndRuntime(
  config: Partial<JobRecord> & Pick<JobRecord, "id" | "name" | "type" | "appIds" | "createdAt">,
  runtime?: Partial<JobRuntimeSlice> | null,
): JobRecord {
  const baseRuntime = defaultJobRuntime(config.createdAt);
  const mergedRuntime = { ...baseRuntime, ...runtime };
  return {
    ...(config as JobConfigSlice),
    ...(mergedRuntime as JobRuntimeSlice),
  } as JobRecord;
}

/** Strip runtime from a monolithic record for git commit safety. */
export function stripRuntimeForGit(record: JobRecord): JobConfigSlice {
  return splitJobRecord(record).config;
}

/** Config-only projection for data/jobs.json index when runtime is off git. */
export function toConfigIndexEntry(record: JobRecord): JobConfigSlice {
  return splitJobRecord(record).config;
}

/** Build heartbeat/API runtime patch from an in-memory job record. */
export function jobRecordToRuntimePatch(
  job: JobRecord,
  source: string = "desktop",
): JobRuntimePatch {
  const { runtime } = splitJobRecord(job);
  const patch: JobRuntimePatch = {
    jobId: job.id,
    status: job.status,
    recordedAt: job.updatedAt,
    source,
    jobName: job.name,
  };
  if (runtime.lastRunAt !== undefined) patch.lastRunAt = runtime.lastRunAt;
  if (runtime.completedAt !== undefined) patch.completedAt = runtime.completedAt;
  if (runtime.exitCode !== undefined) patch.exitCode = runtime.exitCode;
  if (runtime.error !== undefined) patch.error = runtime.error ?? null;
  if (runtime.lastOutput !== undefined) patch.lastOutput = runtime.lastOutput;
  if (runtime.scheduleState !== undefined) {
    patch.scheduleState = runtime.scheduleState;
  }
  return patch;
}

export function recordHasRuntimeFields(record: Record<string, unknown>): boolean {
  return JOB_RUNTIME_FIELD_KEYS.some((key) => record[key] !== undefined);
}

/** Stable SHA256 of config JSON for content-hash comparisons. */
export function hashJobConfigContent(config: JobConfigSlice): string {
  const stable = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(stable).digest("hex");
}

export function parseJobStatus(value: string): JobStatus {
  const allowed: JobStatus[] = [
    "pending",
    "running",
    "waiting_permission",
    "completed",
    "failed",
    "cancelled",
  ];
  if (allowed.includes(value as JobStatus)) {
    return value as JobStatus;
  }
  return "failed";
}

/** Parse loose job.json / jobs.json objects into config + runtime slices. */
export function parseMonolithicJobJson(raw: Record<string, unknown>): {
  config: Partial<JobRecord>;
  runtime: Partial<JobRuntimeSlice>;
} {
  const config: Record<string, unknown> = {};
  const runtime: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CONFIG_KEY_SET.has(key)) {
      config[key] = value;
    } else if (RUNTIME_KEY_SET.has(key)) {
      runtime[key] = value;
    }
  }
  return {
    config: config as Partial<JobRecord>,
    runtime: runtime as Partial<JobRuntimeSlice>,
  };
}

export const JOB_RUNTIME_FILE_NAME = "job.runtime.json";
