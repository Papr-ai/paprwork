/**
 * Resolves registry database write targets for jobs (writeDbIds).
 * JOB_DB remains job-local scratch only — never linked to mini-apps.
 */

import { existsSync } from "fs";
import path from "path";
import { getPaprDataDir, getPaprRoot } from "../../core/utils/paprRoot.js";
import type { JobRecord } from "./jobs/types.js";
import { STANDALONE_APP_ID } from "./jobs/appIds.js";
import type { DatabaseRecord } from "./DatabaseRegistryService.js";
import { rewritePaprPathForCloudRun } from "./cloudAgentGateway/cloudPaprPath.js";
import {
  extractDatabaseSlugFromPath,
  workspaceRegistryDbPath,
} from "./resolveRegistryDbPath.js";

export interface JobWriteDatabaseTarget {
  dbId: string;
  alias: string;
  dbPath: string;
  /** Env suffix e.g. METRICS → PAPR_DB_METRICS */
  envKey: string;
}

export function databaseEnvKey(
  record: Pick<DatabaseRecord, "dbId" | "label">,
): string {
  const fromLabel = (record.label ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  if (fromLabel) {
    return fromLabel;
  }
  return record.dbId.toUpperCase().replace(/-/g, "_");
}

function isCloudRunSandbox(paprHome: string): boolean {
  return (
    paprHome.includes(`${path.sep}papr-cloud-run${path.sep}`) ||
    paprHome.includes(`${path.sep}papr-cloud-session${path.sep}`)
  );
}

/** Resolve a registry db path for the active workspace (desktop or cloud sandbox). */
export function registryDbPathCandidates(storedPath: string): string[] {
  const trimmed = storedPath.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(trimmed);

  const slug = extractDatabaseSlugFromPath(trimmed);
  if (slug) {
    add(workspaceRegistryDbPath(slug, getPaprDataDir()));
  }

  const paprHome = getPaprRoot();
  if (isCloudRunSandbox(paprHome)) {
    add(rewritePaprPathForCloudRun(trimmed, paprHome));
  }

  return candidates;
}

export function resolveExistingRegistryDbPath(storedPath: string): string | null {
  for (const candidate of registryDbPathCandidates(storedPath)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function targetFromRegistryRecord(
  record: DatabaseRecord,
  dbPath: string = record.localPath,
): JobWriteDatabaseTarget {
  const alias = record.label?.trim() || record.dbId;
  return {
    dbId: record.dbId,
    alias,
    dbPath,
    envKey: databaseEnvKey(record),
  };
}

async function loadRegistryRecord(
  dbId: string,
): Promise<DatabaseRecord | null> {
  const { initializeDatabaseRegistry } = await import(
    "./DatabaseRegistryService.js"
  );
  const registry = await initializeDatabaseRegistry();
  const record = registry.getById(dbId);
  if (!record || record.status === "tombstone") {
    return null;
  }
  return record;
}

export async function resolveJobWriteTargets(
  job: Pick<JobRecord, "writeDbIds" | "appIds">,
): Promise<JobWriteDatabaseTarget[]> {
  const writeDbIds = job.writeDbIds ?? [];
  if (writeDbIds.length > 0) {
    const targets: JobWriteDatabaseTarget[] = [];
    for (const dbId of writeDbIds) {
      const record = await loadRegistryRecord(dbId);
      if (!record) {
        throw new Error(
          `writeDbIds references unknown or tombstoned database: ${dbId}. ` +
            "Create it with create_database first.",
        );
      }
      const dbPath = resolveExistingRegistryDbPath(record.localPath);
      if (!dbPath) {
        throw new Error(
          `Database ${dbId} local file missing: ${record.localPath}. ` +
            `Checked workspace paths under ${getPaprDataDir()}. ` +
            "Run create_database or restore from sync before running this job.",
        );
      }
      targets.push(targetFromRegistryRecord(record, dbPath));
    }
    return targets;
  }

  // Legacy fallback: jobs created before writeDbIds used app primary linked source.
  const linkedAppIds = (job.appIds ?? []).filter((id) => id !== STANDALONE_APP_ID);
  if (linkedAppIds.length === 0) {
    return [];
  }

  const { getAppService } = await import("./AppService.js");
  const appService = getAppService();
  await appService.initialize();
  const primary = await appService.getPrimaryDataSource(linkedAppIds[0]);
  if (!primary?.dbId) {
    return [];
  }

  const record = await loadRegistryRecord(primary.dbId);
  const storedPath = record?.localPath ?? primary.dbPath ?? "";
  const dbPath = resolveExistingRegistryDbPath(storedPath);
  if (!dbPath) {
    return [];
  }

  if (!record) {
    return [
      {
        dbId: primary.dbId,
        alias: primary.alias,
        dbPath,
        envKey: databaseEnvKey({ dbId: primary.dbId, label: primary.alias }),
      },
    ];
  }
  return [targetFromRegistryRecord(record, dbPath)];
}

/** @deprecated Use resolveJobWriteTargets — kept for legacy call sites during migration. */
export interface JobAppDatabaseContext {
  appId: string;
  appDb: string;
  appDbAlias: string;
}

/** @deprecated */
export async function resolveJobAppDatabase(
  appIds: readonly string[] | undefined,
): Promise<JobAppDatabaseContext | null> {
  const linkedAppIds = (appIds ?? []).filter((id) => id !== STANDALONE_APP_ID);
  if (linkedAppIds.length === 0) return null;

  const targets = await resolveJobWriteTargets({ appIds: [...linkedAppIds] });
  if (targets.length === 0) return null;

  return {
    appId: linkedAppIds[0],
    appDb: targets[0].dbPath,
    appDbAlias: targets[0].alias,
  };
}

export async function requireJobWriteTargets(
  job: Pick<JobRecord, "writeDbIds" | "appIds" | "command" | "type">,
): Promise<JobWriteDatabaseTarget[]> {
  const targets = await resolveJobWriteTargets(job);
  const hasWriteDbIds = (job.writeDbIds ?? []).length > 0;
  const linkedAppIds = (job.appIds ?? []).filter((id) => id !== STANDALONE_APP_ID);

  if (targets.length > 0) {
    return targets;
  }

  const command = job.command ?? "";
  const appDataIntent =
    /\$\{?PAPR_DB_|APP_DB|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(
      command,
    );

  if (linkedAppIds.length > 0 && appDataIntent && hasWriteDbIds) {
    throw new Error(
      "Job declares writeDbIds but none resolved. Check registry dbIds with list_databases.",
    );
  }

  if (linkedAppIds.length > 0 && appDataIntent && !hasWriteDbIds) {
    throw new Error(
      "Job writes app-facing SQLite but has no writeDbIds. " +
        "Set writeDbIds to registry dbId(s) from create_database, or use $JOB_DB for scratch-only jobs.",
    );
  }

  return [];
}

/** @deprecated Use requireJobWriteTargets */
export async function requireJobAppDatabase(
  appIds: readonly string[] | undefined,
): Promise<JobAppDatabaseContext | null> {
  const ctx = await resolveJobAppDatabase(appIds);
  return ctx;
}

export function jobWriteDatabaseEnv(
  targets: readonly JobWriteDatabaseTarget[],
  appId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (appId) {
    env.APP_ID = appId;
  }

  for (const target of targets) {
    env[`PAPR_DB_${target.envKey}`] = target.dbPath;
    env[`PAPR_DB_${target.envKey}_ALIAS`] = target.alias;
    env[`PAPR_DB_${target.envKey}_ID`] = target.dbId;
  }

  if (targets.length > 0) {
    env.PAPR_WRITE_DB_IDS = targets.map((t) => t.dbId).join(",");
    // Backward compatibility for scripts using APP_DB
    env.APP_DB = targets[0].dbPath;
    env.APP_DB_ALIAS = targets[0].alias;
    env.APP_DB_ID = targets[0].dbId;
  }

  return env;
}

/** @deprecated */
export function jobAppDatabaseEnv(
  ctx: JobAppDatabaseContext,
): Record<string, string> {
  return jobWriteDatabaseEnv(
    [
      {
        dbId: "",
        alias: ctx.appDbAlias,
        dbPath: ctx.appDb,
        envKey: databaseEnvKey({ dbId: "legacy", label: ctx.appDbAlias }),
      },
    ],
    ctx.appId,
  );
}

export function jobWriteDatabasePromptLines(
  targets: readonly JobWriteDatabaseTarget[],
): string[] {
  if (targets.length === 0) {
    return [
      "No registry write databases injected for this job.",
      "Use $JOB_DB for scratch (job_runs, temp tables) only.",
    ];
  }

  const lines = [
    "Write targets (registry SQLite — mini-apps read via /api/db/query + sourceId):",
  ];
  for (const target of targets) {
    lines.push(
      `  PAPR_DB_${target.envKey}="${target.dbPath}"  (${target.alias}, dbId=${target.dbId})`,
    );
  }
  lines.push(
    "",
    "Use PAPR_DB_* paths for app-facing tables. Use $JOB_DB only for scratch.",
  );
  if (targets.length === 1) {
    lines.push(`Legacy alias: APP_DB="${targets[0].dbPath}"`);
  }
  return lines;
}

/** @deprecated */
export function jobAppDatabasePromptLines(
  ctx: JobAppDatabaseContext,
): string[] {
  return jobWriteDatabasePromptLines([
    {
      dbId: "",
      alias: ctx.appDbAlias,
      dbPath: ctx.appDb,
      envKey: databaseEnvKey({ dbId: "legacy", label: ctx.appDbAlias }),
    },
  ]);
}

export async function validateWriteDbIdsExist(
  writeDbIds: readonly string[] | undefined,
): Promise<void> {
  for (const dbId of writeDbIds ?? []) {
    const record = await loadRegistryRecord(dbId);
    if (!record) {
      throw new Error(`Database not found in registry: ${dbId}`);
    }
  }
}
