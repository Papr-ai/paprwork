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
import type { DatabaseSyncMode } from "./tursoReplica/tursoReplicaTypes.js";
import { rewritePaprPathForCloudRun } from "./cloudAgentGateway/cloudPaprPath.js";
import {
  shouldUseCloudSandboxTursoDirect,
  type CloudSandboxTursoCredentials,
} from "./cloudAgentGateway/cloudSandboxTursoDirect.js";
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
  /** Cloud sandbox Turso-direct: jobs use HTTP instead of local SQLite path. */
  turso?: CloudSandboxTursoCredentials;
  /**
   * "replica" means a Turso sync engine owns this file's WAL. Jobs must not
   * hold a raw write handle on it: SQLite auto-checkpoints when the last
   * connection closes, truncating the WAL to zero, while the sync engine's
   * data.db-info still points at a byte offset inside it. The next push then
   * fails with "short read on WAL frame at offset N: expected 4096, got 0".
   */
  syncMode?: DatabaseSyncMode;
}

export interface ResolveJobWriteTargetsOptions {
  actingUserId?: string;
  tursoCredsByDbId?: ReadonlyMap<string, CloudSandboxTursoCredentials>;
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
  if (
    paprHome.includes(`${path.sep}papr-cloud-run${path.sep}`) ||
    paprHome.includes(`${path.sep}papr-cloud-session${path.sep}`)
  ) {
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
    ...(record.syncMode ? { syncMode: record.syncMode } : {}),
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

async function resolveTursoCredsForRegistryRecord(
  record: DatabaseRecord,
  options?: ResolveJobWriteTargetsOptions,
): Promise<CloudSandboxTursoCredentials | null> {
  const fromRequest = options?.tursoCredsByDbId?.get(record.dbId);
  if (fromRequest) {
    return fromRequest;
  }

  const { getTursoSyncBridge } = await import("./TursoSyncBridge.js");
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return null;
  }

  const { tursoNameForRecord } = await import("./DatabaseRegistryService.js");
  const database = tursoNameForRecord(record, options?.actingUserId);
  try {
    const creds = await bridge.fetchCredentials(database);
    return { url: creds.tursoUrl, authToken: creds.authToken };
  } catch {
    return null;
  }
}

async function resolveWriteTargetForRecord(
  record: DatabaseRecord,
  options?: ResolveJobWriteTargetsOptions,
): Promise<JobWriteDatabaseTarget> {
  if (shouldUseCloudSandboxTursoDirect()) {
    const turso = await resolveTursoCredsForRegistryRecord(record, options);
    if (turso) {
      return {
        ...targetFromRegistryRecord(record, record.localPath),
        turso,
      };
    }
  }

  const dbPath = resolveExistingRegistryDbPath(record.localPath);
  if (!dbPath) {
    throw new Error(
      `Database ${record.dbId} local file missing: ${record.localPath}. ` +
        `Checked workspace paths under ${getPaprDataDir()}. ` +
        "Run create_database or restore from sync before running this job.",
    );
  }
  return targetFromRegistryRecord(record, dbPath);
}

export async function resolveJobWriteTargets(
  job: Pick<JobRecord, "writeDbIds" | "appIds">,
  options?: ResolveJobWriteTargetsOptions,
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
      targets.push(await resolveWriteTargetForRecord(record, options));
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
    if (primary?.dbPath && existsSync(primary.dbPath)) {
      const keyId = primary.jobId ?? primary.id;
      return [
        {
          dbId: keyId,
          alias: primary.alias,
          dbPath: primary.dbPath,
          envKey: databaseEnvKey({ dbId: keyId, label: primary.alias }),
        },
      ];
    }
    return [];
  }

  const record = await loadRegistryRecord(primary.dbId);
  const storedPath = record?.localPath ?? primary.dbPath ?? "";
  if (record) {
    try {
      return [await resolveWriteTargetForRecord(record, options)];
    } catch {
      return [];
    }
  }

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

/**
 * A replica-managed file must never be opened for writing by a job process.
 * See JobWriteDatabaseTarget.syncMode for the WAL-truncation mechanism.
 */
export function isReplicaManagedTarget(
  target: Pick<JobWriteDatabaseTarget, "syncMode" | "turso">,
): boolean {
  // Cloud sandbox Turso-direct already writes over HTTP — no local WAL at risk.
  return !target.turso && target.syncMode === "replica";
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
    const prefix = `PAPR_DB_${target.envKey}`;
    env[`${prefix}_ALIAS`] = target.alias;
    env[`${prefix}_ID`] = target.dbId;
    if (target.turso) {
      env[`${prefix}_MODE`] = "turso";
      env[`${prefix}_URL`] = target.turso.url;
      env[`${prefix}_AUTH_TOKEN`] = target.turso.authToken;
    } else {
      // The path stays exported either way: reads are the common case and a
      // read-only handle never checkpoints. "replica" mode tells papr_db to
      // open it mode=ro and route writes through the gateway proxy instead.
      env[prefix] = target.dbPath;
      env[`${prefix}_MODE`] = isReplicaManagedTarget(target)
        ? "replica"
        : "local";
    }
  }

  if (targets.length > 0) {
    env.PAPR_WRITE_DB_IDS = targets.map((t) => t.dbId).join(",");
    const first = targets[0];
    env.APP_DB_ALIAS = first.alias;
    env.APP_DB_ID = first.dbId;
    if (first.turso) {
      env.PAPR_DB_MODE = "turso";
      env.PAPR_DB_URL = first.turso.url;
      env.PAPR_DB_AUTH_TOKEN = first.turso.authToken;
    } else {
      env.APP_DB = first.dbPath;
      env.PAPR_DB_MODE = isReplicaManagedTarget(first) ? "replica" : "local";
    }
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
    "Write targets (registry databases — mini-apps read via /api/db/query + sourceId):",
  ];
  let hasReplica = false;
  for (const target of targets) {
    if (target.turso) {
      lines.push(
        `  PAPR_DB_${target.envKey}_MODE=turso  (${target.alias}, dbId=${target.dbId})`,
      );
    } else if (isReplicaManagedTarget(target)) {
      hasReplica = true;
      lines.push(
        `  PAPR_DB_${target.envKey}="${target.dbPath}"  (${target.alias}, dbId=${target.dbId}) [replica — read-only file]`,
      );
    } else {
      lines.push(
        `  PAPR_DB_${target.envKey}="${target.dbPath}"  (${target.alias}, dbId=${target.dbId})`,
      );
    }
  }

  if (hasReplica) {
    // Without this the agent writes sqlite3.connect(APP_DB), which truncates
    // the WAL on close and wedges the replica's sync engine. Telling it the
    // right API is the only durable fix — agent jobs rewrite their own scripts.
    lines.push(
      "",
      "A [replica] database is sync-managed. In Python use the bundled helper:",
      "    import papr_db",
      "    con = papr_db.connect()          # or papr_db.connect(\"alias\")",
      "    con.execute(\"INSERT INTO t (a) VALUES (?)\", [v])",
      "",
      "It reads the file read-only and sends writes through the gateway.",
      "Do NOT call sqlite3.connect() on a [replica] path, and do NOT use the",
      "sqlite3 CLI on it: closing a write handle checkpoints and truncates the",
      "WAL, which corrupts sync and blocks every later write.",
    );
  } else {
    lines.push(
      "",
      "Use PAPR_DB_* paths for app-facing tables. Use $JOB_DB only for scratch.",
    );
  }

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
