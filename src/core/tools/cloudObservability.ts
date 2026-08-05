/**
 * Agent tools for inspecting cloud sync, Turso replicas, GitHub repo state,
 * and cloud job runtime status.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getCloudSyncStatus,
  listCloudRepoFiles,
  pushCloudSync,
  queryCloudTurso,
  readCloudRepoFile,
} from "../../gateway/services/CloudObservabilityService.js";

function unwrapContext<T>(input: T | { context?: T }): T {
  if (input && typeof input === "object" && "context" in input) {
    return (input as { context?: T }).context ?? (input as T);
  }
  return input as T;
}

function toolError(error: unknown, startTime: number): never {
  throw new Error(
    JSON.stringify({
      success: false,
      error: (error as Error).message,
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    }),
  );
}

const getCloudSyncStatusSchema = z.object({
  appId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional mini-app ID to scope GitHub/Turso/cloud-link/job status"),
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional job ID — filters jobs section and includes log tail by default"),
  includeJobLogs: z
    .boolean()
    .optional()
    .describe("Include tail of local run.log for matched jobs (default true when jobId set)"),
  logTailLines: z.number().int().min(10).max(500).optional(),
});

export const getCloudSyncStatusTool = createTool({
  id: "get_cloud_sync_status",
  description: `Inspect Papr Cloud health for the active workspace — one call for sync + jobs.

Returns:
- GitHub sync per app/job folder (synced | pending | outdated | failed)
- Turso sync per linked database (local vs remote table counts, dirty/pending)
- apps.papr.ai publish link status
- Desktop heartbeat + pendingCloudRuns (cloud-triggered jobs waiting for desktop)
- jobs.local — local job status (optionally with log tail)
- jobs.githubRecords — job.json snapshots from GitHub for app-dependent jobs

Use before debugging cloud mini-apps, Turso drift, or jobs stuck pending on apps.papr.ai.
Read-only. To fix issues use push_cloud_sync, run_job, update_job, or publish_cloud_app.
Requires Papr login (PAPR_API_KEY).`,
  inputSchema: getCloudSyncStatusSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const startTime = performance.now();
    try {
      const data = await getCloudSyncStatus({
        appId: args.appId,
        jobId: args.jobId,
        includeJobLogs: args.includeJobLogs,
        logTailLines: args.logTailLines,
      });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

const queryCloudTursoSchema = z.object({
  sql: z
    .string()
    .min(1)
    .describe("Read-only SQL (SELECT/WITH/PRAGMA/EXPLAIN only). LIMIT added automatically if missing."),
  tursoDatabase: z
    .string()
    .optional()
    .describe("Turso short name, e.g. j-de1a89d8"),
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe("Linked job ID — resolves to its Turso database"),
  appId: z
    .string()
    .uuid()
    .optional()
    .describe("Mini-app ID — pair with alias from data-sources.json"),
  alias: z
    .string()
    .optional()
    .describe("Linked database alias from the app's data-sources.json"),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max rows to return (default 50, cap 200)"),
});

export const queryCloudTursoTool = createTool({
  id: "query_cloud_turso",
  description: `Run a read-only SQL query against a Turso cloud replica.

Target the database with ONE of:
- tursoDatabase (short name from get_cloud_sync_status)
- jobId (linked job UUID)
- appId + alias (from data-sources.json)

Examples:
- query_cloud_turso({ jobId: "...", sql: "SELECT name FROM sqlite_master WHERE type='table'" })
- query_cloud_turso({ appId: "...", alias: "app", sql: "SELECT * FROM audits ORDER BY created_at DESC" })

Use to verify cloud web apps see the same rows as local SQLite after sync.`,
  inputSchema: queryCloudTursoSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const startTime = performance.now();
    try {
      const data = await queryCloudTurso(args);
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

const inspectCloudRepoSchema = z.object({
  action: z
    .enum(["read", "list"])
    .describe("read = fetch one file from GitHub cloud repo; list = list paths in local git HEAD"),
  relativePath: z
    .string()
    .optional()
    .describe("Repo-relative path for action=read, e.g. apps/{appId}/dist/app.js"),
  source: z
    .enum(["github", "local-git"])
    .optional()
    .describe("For action=read: github (default, live cloud) or local-git (last committed HEAD)"),
  prefix: z
    .string()
    .optional()
    .describe("Path prefix for action=list (default apps/)"),
  maxFiles: z.number().int().min(1).max(500).optional(),
  maxChars: z.number().int().min(500).max(50_000).optional(),
});

export const inspectCloudRepoTool = createTool({
  id: "inspect_cloud_repo",
  description: `Inspect files in Papr's GitHub cloud repo (papr-work user repo).

action=read — fetch a single file from live GitHub (default) or local git HEAD (source=local-git). Provide relativePath.

action=list — list tracked files under a prefix from local git HEAD (matches last pushed state after sync).

Use to verify dist/app.js, linked-databases.json, Jobs/{id}/job.json reached GitHub.`,
  inputSchema: inspectCloudRepoSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const startTime = performance.now();
    try {
      if (args.action === "read") {
        if (!args.relativePath) {
          throw new Error("action=read requires relativePath.");
        }
        const data = await readCloudRepoFile({
          relativePath: args.relativePath,
          source: args.source,
          maxChars: args.maxChars,
        });
        return {
          success: true,
          data,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      const data = await listCloudRepoFiles({
        prefix: args.prefix,
        maxFiles: args.maxFiles,
      });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

const pushCloudSyncSchema = z.object({
  appId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional mini-app ID — push only that app and its dependent jobs. Omit to push full workspace."),
});

export const pushCloudSyncTool = createTool({
  id: "push_cloud_sync",
  description: `Force Cloud Sync push to GitHub + Turso (same as Settings → Sync now).

Use after fixing local app/job code or SQLite data and you need cloud (apps.papr.ai) updated immediately.
Optionally scope to one appId (pushes app folder + dependent job folders + linked Turso sources).

After push, call get_cloud_sync_status to verify github/turso sections show synced.`,
  inputSchema: pushCloudSyncSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const startTime = performance.now();
    try {
      const data = await pushCloudSync({ appId: args.appId });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudObservabilityTools = [
  getCloudSyncStatusTool,
  pushCloudSyncTool,
  queryCloudTursoTool,
  inspectCloudRepoTool,
];
