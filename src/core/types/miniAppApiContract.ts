/**
 * Frozen mini-app API contracts (§8.2 SYNC_ARCHITECTURE_V3).
 * Zod schemas pin request/response shapes — CI rejects breaking changes.
 */

import { z } from "zod";

/** POST /api/db/write — success response */
export const MiniAppDbWriteResponseSchema = z.object({
  changes: z.number(),
  lastInsertRowid: z.union([z.number(), z.bigint()]).optional(),
});

/** POST /api/db/write-batch — per-statement result */
export const MiniAppDbWriteBatchResultSchema = z.object({
  ok: z.boolean(),
  changes: z.number().optional(),
  lastInsertRowid: z.union([z.number(), z.bigint()]).optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});

/** POST /api/db/write-batch — success response */
export const MiniAppDbWriteBatchResponseSchema = z.object({
  results: z.array(MiniAppDbWriteBatchResultSchema),
});

/** POST /api/db/write — error response */
export const MiniAppApiErrorSchema = z.object({
  error: z.string(),
});

/** POST /api/db/query — success response */
export const MiniAppDbQueryResponseSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  backend: z.string().optional(),
  /** Gateway adds linked source alias on local preview. */
  source: z.string().optional(),
});

/** POST /api/db/exec — success response */
export const MiniAppDbExecResponseSchema = z.object({
  success: z.literal(true),
});

/** POST /api/jobs/run — fire-and-forget success */
export const MiniAppJobRunAsyncResponseSchema = z.object({
  jobId: z.string(),
  status: z.literal("running"),
});

/** POST /api/jobs/run — wait=true success */
export const MiniAppJobRunWaitResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  lastOutput: z.string().optional(),
});

/** POST /api/jobs/run — collision (409) */
export const MiniAppJobRunConflictResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  error: z.string(),
  reason: z.enum(["already_running", "dependency_running"]),
  dependencyId: z.string().optional(),
});

/** GET /api/jobs/list */
export const MiniAppJobsListResponseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      status: z.string(),
      lastRunAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
  ),
  count: z.number(),
});

/** GET /api/jobs/status/:jobId */
export const MiniAppJobStatusResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  lastRunAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  lastOutput: z.string().optional(),
});

/** Documented request bodies (shape-only — handlers may add validation). */
export const MiniAppDbWriteRequestSchema = z.object({
  appId: z.string().optional(),
  sourceId: z.string().optional(),
  sql: z.string(),
  params: z.array(z.unknown()).optional(),
});

export const MiniAppDbWriteBatchRequestSchema = z.object({
  appId: z.string().optional(),
  statements: z.array(
    z.object({
      sourceId: z.string().optional(),
      sql: z.string(),
      params: z.array(z.unknown()).optional(),
    }),
  ),
});

export const MiniAppJobRunRequestSchema = z.object({
  jobId: z.string(),
  wait: z.boolean().optional(),
  params: z.record(z.string(), z.string()).optional(),
});
