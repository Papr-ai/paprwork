/**
 * Agent tools for inspecting cloud sync, Turso replicas, GitHub repo state,
 * and cloud job runtime status.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getCloudSyncStatus,
  listCloudRepoFiles,
  hasPushCloudSyncScope,
  PUSH_CLOUD_SYNC_REQUIRES_SCOPE_ERROR,
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
- workspaceApps — apps in this workspace from local apps.json (what exists on disk)
- appWriterRepo (when appId set) — per-app GitHub repo URL, last commit, Sync V3 upload status (use this to verify cloud code)
- github — legacy namespace monorepo (workspace/, Jobs/ only — apps/ rows omitted as misleading)
- Turso sync per linked database — legacy CDC fields plus Plan A replica fields when syncMode=replica: pendingPush, pendingOps, online, migrationConflict, lastReplicaPushError, cutoverBlocked
- apps.papr.ai publish link status
- Desktop heartbeat + pendingCloudRuns (cloud-triggered jobs waiting for desktop)
- jobs.local — local job status (optionally with log tail)
- jobs.githubRecords — job.json snapshots from GitHub for app-dependent jobs
- oversizedAppFiles — files in the app folder over 10MB that git sync skips (use App Files instead)

Use before debugging cloud mini-apps, Turso drift, migration conflicts, or jobs stuck pending on apps.papr.ai.
NEVER use bash git ls-files/status on apps/{id}/ in the namespace repo — use appWriterRepo from this tool instead.
Read-only. To fix: push_cloud_sync (git + ordered flush), papr_db_push/pull (replica row sync), repair_cloud_sync (migration conflicts), run_job, publish_cloud_app.
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
    .describe("read = fetch one file from per-app writer repo; list = list paths in per-app repo"),
  appId: z
    .string()
    .uuid()
    .optional()
    .describe("Mini-app ID — REQUIRED for app code (Sync V3 per-app GitHub repo). Inferrable from apps/{appId}/... paths on read."),
  relativePath: z
    .string()
    .optional()
    .describe("Repo-relative path for action=read, e.g. dist/app.js or apps/{appId}/dist/app.js"),
  source: z
    .enum(["github", "local-git"])
    .optional()
    .describe("For action=read without appId: legacy namespace monorepo only. Prefer appId for app files."),
  prefix: z
    .string()
    .optional()
    .describe("Path prefix for action=list inside per-app repo (default root), e.g. dist/ or backend/"),
  maxFiles: z.number().int().min(1).max(500).optional(),
  maxChars: z.number().int().min(500).max(50_000).optional(),
});

export const inspectCloudRepoTool = createTool({
  id: "inspect_cloud_repo",
  description: `Check app code in the Sync V3 per-app writer GitHub repo (canonical "check app repo" tool).

action=read — fetch a file, e.g. relativePath: "dist/app.js" with appId set.

action=list — list files in the per-app repo. Requires appId. Use prefix dist/, backend/, jobs/, etc.

Do NOT use paths like apps/{appId}/dist/app.js without appId — that hits the wrong legacy namespace repo and returns 404 even after a successful upload.`,
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
          appId: args.appId,
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
        appId: args.appId,
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
    .describe("Mini-app ID — limits GitHub + Turso to this app and dependent jobs"),
  jobId: z
    .string()
    .uuid()
    .optional()
    .describe("Job ID — GitHub: Jobs/{id}; Turso: linked DB for that job if any"),
  alias: z
    .string()
    .optional()
    .describe("Linked DB alias from data-sources.json (use with appId for one Turso database)"),
  tursoDatabase: z
    .string()
    .optional()
    .describe("Turso short name from get_cloud_sync_status, e.g. d-2d6b4294"),
  tables: z
    .array(z.string().min(1))
    .optional()
    .describe("Turso only: sync specific tables (schema + rows), e.g. ['audits']"),
  targets: z
    .array(z.enum(["github", "turso"]))
    .optional()
    .describe(
      "What to push. Default: both (recommended for appId — database then code, same as Upload now). " +
        "['turso'] = database only. ['github'] = code folders only — does NOT sync linked DBs or refresh live web app.",
    ),
}).refine(hasPushCloudSyncScope, {
  message: PUSH_CLOUD_SYNC_REQUIRES_SCOPE_ERROR,
});

export const pushCloudSyncTool = createTool({
  id: "push_cloud_sync",
  description: `Force Cloud Sync push (same engine as Upload now) with **required scope** — full-workspace push is rejected.

Targets (default: both github + turso — use this for appId when the live web app should update):
- github — apps/{id}, Jobs/{id}, data/ to GitHub (code only — skips database + live link refresh)
- turso — linked SQLite → Turso (legacy CDC or Plan A replica push, depending on syncMode)

For registry DBs on Plan A replica path (syncMode=replica), turso target uses papr_db_push semantics (pull-before-push, migration conflict detection). Prefer papr_db_push for row-only fixes on a single dbId.

Scope examples (always pass at least one scope field):
- push_cloud_sync({ appId }) — **recommended** — database, then app code + jobs (ordered, like Upload now)
- push_cloud_sync({ appId, targets: ['turso'] }) — Turso DBs for one app only (DB fix, no code publish)
- push_cloud_sync({ appId, alias: 'gtm-audit', targets: ['turso'] }) — one linked database
- push_cloud_sync({ appId, alias: 'gtm-audit', tables: ['audits'], targets: ['turso'] }) — one table
- push_cloud_sync({ tursoDatabase: 'd-2d6b4294', targets: ['turso'] }) — by Turso short name
- push_cloud_sync({ appId, jobId, targets: ['github'] }) — job script folder only (not for live app refresh)
- push_cloud_sync({ jobId }) — job folder + linked job DB when applicable

Do NOT call push_cloud_sync with no appId/jobId/alias/tursoDatabase/tables. For one DB row sync only, use papr_db_push({ dbId }).

Do NOT use targets: ['github'] alone when the user expects the web app or database to update — use default both or Upload now.

Returns scope label, github pushedPaths, turso databases touched, durationMs.
When oversizedAppFiles is present, those paths were skipped — register them with App Files before publishing.
After push, call get_cloud_sync_status to verify.`,
  inputSchema: pushCloudSyncSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const startTime = performance.now();
    try {
      const data = await pushCloudSync({
        appId: args.appId,
        jobId: args.jobId,
        alias: args.alias,
        tursoDatabase: args.tursoDatabase,
        tables: args.tables,
        targets: args.targets,
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

export const cloudObservabilityTools = [
  getCloudSyncStatusTool,
  pushCloudSyncTool,
  queryCloudTursoTool,
  inspectCloudRepoTool,
];
