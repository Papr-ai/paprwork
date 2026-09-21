/**
 * Post-install bootstrap for cloud/community mini-apps:
 * resolve linked DB paths, apply git migrations locally, optional Turso row pull.
 */

import { openDiagnosticDatabase } from "./databaseDiagnostics/sqlite.js";

import { existsSync, statSync } from "fs";
import fs from "fs/promises";
import Database from "better-sqlite3";
import path from "path";
import { getPaprAppsRoot, getPaprJobsRoot } from "../../core/utils/paprRoot.js";
import {
  parseDataSourcesFile,
  type AppDataSource,
} from "./appDataSources.js";
import { resolveLinkedSourceDbPath } from "./portableDataSources.js";
import {
  applyDatabaseMigrations,
  applyRegistryDatabaseMigrations,
} from "./jobs/databaseMigrations.js";
import type { PullResult } from "./tursoSyncBridgeCore.js";
import type { SyncSummary } from "./TursoSyncBridge.js";
import type { InstallDbPolicy } from "./cloudInstallDbPolicy.js";
import type { DatabasesRegistryFile } from "./DatabaseRegistryService.js";
import { retryWhileReplicaBusy } from "./tursoReplica/replicaBusyRetry.js";

function isLocalDbReadable(dbPath: string): boolean {
  try {
    return existsSync(dbPath) && statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

export type TursoPullOutcome =
  | "pulled"
  | "empty_remote"
  | "skipped"
  | "unavailable"
  | "failed";

export interface LinkedDbBootstrapResult {
  alias: string;
  dbId?: string;
  jobId?: string;
  localPath: string;
  migrationsApplied: string[];
  tursoPull: TursoPullOutcome;
  userTableCount: number;
  writable: boolean;
  warnings: string[];
  errors: string[];
}

export interface InstallBootstrapResult {
  appId: string;
  linkedDbs: LinkedDbBootstrapResult[];
  /** Local schema exists and DB files are writable. */
  ready: boolean;
  /** Schema OK but no user tables yet — run linked seed job. */
  needsSeed: boolean;
  errors: string[];
  warnings: string[];
}

function countUserTables(dbPath: string): number {
  if (!existsSync(dbPath)) {
    return 0;
  }
  let db: Database.Database | null = null;
  try {
    db = openDiagnosticDatabase(Database, "services/cloudAppInstallBootstrap", dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '_papr_%'
           AND name NOT IN ('schema_migrations', 'job_runs', 'job_events')`,
      )
      .all() as Array<{ name: string }>;
    return rows.length;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

function mapTursoPullOutcome(
  summary: SyncSummary | null,
  syncKey: string,
  pullResults: Map<string, PullResult | undefined>,
): TursoPullOutcome {
  if (!summary) {
    return "unavailable";
  }
  const direct = pullResults.get(syncKey);
  if (direct?.status === "pulled") {
    return "pulled";
  }
  if (direct?.status === "skipped") {
    if (direct.reason === "no_remote_tables" || direct.reason === "no_syncable_remote_tables") {
      return "empty_remote";
    }
    return "skipped";
  }
  const result = summary.results.find((entry) => entry.jobId === syncKey);
  if (result?.error) {
    return "failed";
  }
  if (result?.pull?.status === "pulled") {
    return "pulled";
  }
  if (
    result?.pull?.status === "skipped" &&
    (result.pull.reason === "no_remote_tables" ||
      result.pull.reason === "no_syncable_remote_tables")
  ) {
    return "empty_remote";
  }
  if (result?.pull?.status === "skipped") {
    return "skipped";
  }
  return "skipped";
}

async function applyMigrationsForSource(
  source: AppDataSource,
  localPath: string,
  options?: { localOnly?: boolean },
): Promise<string[]> {
  const label = `cloud-install-migration:${source.alias ?? localPath}`;
  return retryWhileReplicaBusy(async () => {
    const migrationOptions = options?.localOnly
      ? { bypassReplicaEngine: true as const }
      : undefined;
    if (source.dbId && !source.jobId) {
      return applyRegistryDatabaseMigrations(localPath, migrationOptions);
    }
    if (source.jobId) {
      const jobDir = path.join(getPaprJobsRoot(), source.jobId);
      return applyDatabaseMigrations(jobDir, localPath, migrationOptions);
    }
    return applyRegistryDatabaseMigrations(localPath, migrationOptions);
  }, label);
}

async function resolveBootstrapLocalPath(
  source: AppDataSource,
  options?: {
    paprHome?: string;
    registry?: DatabasesRegistryFile;
  },
): Promise<string | null> {
  const jobsRoot = options?.paprHome
    ? path.join(options.paprHome, "Jobs")
    : getPaprJobsRoot();
  const dataDir = options?.paprHome
    ? path.join(options.paprHome, "data")
    : undefined;
  const registryRecord =
    source.dbId && options?.registry
      ? options.registry.databases[source.dbId]
      : undefined;
  const localPath = await resolveLinkedSourceDbPath({
    dbPath: source.dbPath,
    dbId: source.dbId,
    jobId: source.jobId,
    jobsRoot,
    registryLabel: registryRecord?.label ?? source.alias,
    dataDir,
    registryRecord,
  });
  return localPath?.trim() ? localPath : null;
}

async function bootstrapLinkedSource(
  source: AppDataSource,
  tursoSummary: SyncSummary | null,
  pullResults: Map<string, PullResult | undefined>,
  options?: {
    tursoPullOnly?: boolean;
    skipMigrations?: boolean;
    migrationsApplied?: string[];
    localOnly?: boolean;
    paprHome?: string;
    registry?: DatabasesRegistryFile;
  },
): Promise<LinkedDbBootstrapResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const localPath = await resolveBootstrapLocalPath(source, options);

  if (!localPath) {
    errors.push(
      `Could not resolve local path for alias "${source.alias}"` +
        (source.dbId ? ` (dbId ${source.dbId})` : "") +
        (source.jobId ? ` (jobId ${source.jobId})` : "") +
        ". Registry entry or linked-databases.json may be missing.",
    );
    return {
      alias: source.alias,
      dbId: source.dbId,
      jobId: source.jobId,
      localPath: "",
      migrationsApplied: [],
      tursoPull: "skipped",
      userTableCount: 0,
      writable: false,
      warnings,
      errors,
    };
  }

  let migrationsApplied: string[] = options?.migrationsApplied ?? [];
  if (!options?.tursoPullOnly && !options?.skipMigrations) {
    try {
      migrationsApplied = await applyMigrationsForSource(source, localPath, {
        localOnly: options?.localOnly,
      });
    } catch (error) {
      errors.push(
        `Migration failed for "${source.alias}" at ${localPath}: ${(error as Error).message}`,
      );
    }
  }

  const syncKey = source.dbId ?? source.jobId ?? localPath;
  const tursoPull: TursoPullOutcome = options?.localOnly
    ? "skipped"
    : mapTursoPullOutcome(tursoSummary, syncKey, pullResults);

  if (options?.localOnly) {
    /* Community fork: local schema only until the user publishes and syncs. */
  } else if (tursoPull === "unavailable") {
    warnings.push(
      `Turso pull skipped for "${source.alias}" (cloud sync off, not logged in, or bridge unavailable). Local schema from git migrations was applied when present.`,
    );
  } else if (tursoPull === "empty_remote") {
    warnings.push(
      `Turso database for "${source.alias}" is empty — expected for a fresh fork. Run the linked setup job to seed rows if the app needs starter data.`,
    );
  } else if (tursoPull === "failed") {
    warnings.push(
      `Turso pull failed for "${source.alias}". Local schema may still work; try Sync now in the publish bar.`,
    );
  }

  // Plan A replica files: never open with better-sqlite3 (even readonly) on pull-only track sync.
  const userTableCount = options?.tursoPullOnly
    ? -1
    : countUserTables(localPath);
  const writable = isLocalDbReadable(localPath);

  if (!writable && errors.length === 0) {
    errors.push(
      `Local database not readable at ${localPath} after bootstrap.`,
    );
  }

  if (writable && userTableCount === 0 && errors.length === 0 && !options?.tursoPullOnly) {
    warnings.push(
      `Database "${source.alias}" has no user tables yet. Run the linked job on this device or seed via the app setup flow.`,
    );
  }

  return {
    alias: source.alias,
    dbId: source.dbId,
    jobId: source.jobId,
    localPath,
    migrationsApplied,
    tursoPull,
    userTableCount,
    writable,
    warnings,
    errors,
  };
}

async function readAppDataSources(
  appId: string,
  paprHome?: string,
): Promise<AppDataSource[]> {
  const appsRoot = paprHome
    ? path.join(paprHome, "apps")
    : getPaprAppsRoot();
  const configPath = path.join(appsRoot, appId, "data-sources.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return parseDataSourcesFile(raw).sources;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readRegistryFromPaprHome(
  paprHome: string,
): Promise<DatabasesRegistryFile> {
  const registryPath = path.join(paprHome, "data", "databases.json");
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return { version: 1, databases: {} };
  }
}

/** Re-pull publisher Turso for track-mode apps with shared database policy. */
export async function pullTrackSharedAppDatabase(
  appId: string,
): Promise<InstallBootstrapResult> {
  return bootstrapInstalledAppDatabases(appId, { tursoPullOnly: true });
}

export interface BootstrapInstalledAppOptions {
  tursoPullOnly?: boolean;
  /** Community fork: apply local migrations only; defer Turso until publish/sync. */
  installDbPolicy?: InstallDbPolicy;
  /**
   * Apply pending migrations under this workspace (cross-namespace copy).
   * Skips Turso sync — target namespace credentials are not active during copy.
   */
  paprHome?: string;
}

function isForkLocalOnlyBootstrap(
  options?: BootstrapInstalledAppOptions,
): boolean {
  return (
    options?.installDbPolicy === "fork_empty" && options.tursoPullOnly !== true
  );
}

function shouldSkipTursoDuringBootstrap(
  options?: BootstrapInstalledAppOptions,
): boolean {
  return isForkLocalOnlyBootstrap(options) || Boolean(options?.paprHome?.trim());
}

/** Apply migrations + optional Turso pull for one installed app. */
export async function bootstrapInstalledAppDatabases(
  appId: string,
  options?: BootstrapInstalledAppOptions,
): Promise<InstallBootstrapResult> {
  const paprHome = options?.paprHome?.trim();
  const sources = await readAppDataSources(appId, paprHome);
  const linkedDbs: LinkedDbBootstrapResult[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const localOnly = shouldSkipTursoDuringBootstrap(options);
  const registry = paprHome
    ? await readRegistryFromPaprHome(paprHome)
    : undefined;
  const workspaceOpts = paprHome
    ? { paprHome, registry }
    : undefined;

  if (sources.length === 0) {
    return {
      appId,
      linkedDbs: [],
      ready: true,
      needsSeed: false,
      errors: [],
      warnings: [],
    };
  }

  let tursoSummary: SyncSummary | null = null;
  const pullResults = new Map<string, PullResult | undefined>();
  const migrationsByAlias = new Map<string, string[]>();
  const runMigrationsBeforeTurso =
    !options?.tursoPullOnly && !localOnly;

  if (runMigrationsBeforeTurso) {
    for (const source of sources) {
      if (source.type !== "sqlite") {
        continue;
      }
      if (!source.dbId && !source.jobId) {
        continue;
      }
      const localPath = await resolveBootstrapLocalPath(source, workspaceOpts);
      if (!localPath) {
        continue;
      }
      try {
        const applied = await applyMigrationsForSource(source, localPath, {
          localOnly: false,
        });
        migrationsByAlias.set(source.alias, applied);
      } catch (error) {
        errors.push(
          `Migration failed for "${source.alias}" at ${localPath}: ${(error as Error).message}`,
        );
      }
    }
  }

  if (!localOnly) {
    try {
      const { ensureTursoSyncBridge, syncTursoAfterAppInstall } = await import(
        "./TursoSyncBridge.js"
      );
      ensureTursoSyncBridge();
      if (options?.tursoPullOnly) {
        const bridge = ensureTursoSyncBridge();
        tursoSummary = await bridge.pullAppLinkedSources(appId, { force: true });
      } else {
        tursoSummary = await syncTursoAfterAppInstall(appId);
      }
      for (const entry of tursoSummary.results) {
        pullResults.set(entry.jobId, entry.pull);
      }
    } catch (error) {
      warnings.push(
        `Turso bootstrap skipped: ${(error as Error).message.slice(0, 160)}`,
      );
    }
  }

  for (const source of sources) {
    if (source.type !== "sqlite") {
      continue;
    }
    if (!source.dbId && !source.jobId) {
      warnings.push(
        `Skipped source "${source.alias}" — no dbId or jobId (not portable).`,
      );
      continue;
    }
    const result = await bootstrapLinkedSource(
      source,
      tursoSummary,
      pullResults,
      {
        ...options,
        localOnly,
        ...workspaceOpts,
        skipMigrations: runMigrationsBeforeTurso,
        migrationsApplied: migrationsByAlias.get(source.alias),
      },
    );
    linkedDbs.push(result);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  const ready =
    linkedDbs.length > 0 &&
    linkedDbs.every((db) => db.writable && db.errors.length === 0);
  const needsSeed =
    ready && linkedDbs.some((db) => db.userTableCount === 0);

  if (localOnly) {
    try {
      const { rebootstrapPendingPortableReplicas } = await import(
        "./tursoReplica/portableReplicaBootstrap.js"
      );
      const replicaBootstrap = await rebootstrapPendingPortableReplicas();
      if (replicaBootstrap.attempted > 0) {
        console.log(
          `[CloudInstall] Fork portable replica bootstrap: ${replicaBootstrap.succeeded}/${replicaBootstrap.attempted} succeeded`,
        );
      }
    } catch (error) {
      warnings.push(
        `Fork portable replica bootstrap skipped: ${(error as Error).message.slice(0, 120)}`,
      );
    }
  } else if (!options?.tursoPullOnly) {
    try {
      const { rebootstrapPendingPortableReplicas } = await import(
        "./tursoReplica/portableReplicaBootstrap.js"
      );
      const replicaBootstrap = await rebootstrapPendingPortableReplicas();
      if (replicaBootstrap.attempted > 0) {
        console.log(
          `[CloudInstall] Portable replica bootstrap: ${replicaBootstrap.succeeded}/${replicaBootstrap.attempted} succeeded`,
        );
      }
    } catch (error) {
      warnings.push(
        `Portable replica bootstrap skipped: ${(error as Error).message.slice(0, 120)}`,
      );
    }
  } else {
    try {
      const { rebootstrapPendingPortableReplicas } = await import(
        "./tursoReplica/portableReplicaBootstrap.js"
      );
      const replicaBootstrap = await rebootstrapPendingPortableReplicas();
      if (replicaBootstrap.succeeded > 0) {
        console.log(
          `[CloudTrackSync] Shared DB pull: ${replicaBootstrap.succeeded}/${replicaBootstrap.attempted} replica(s) refreshed`,
        );
      }
    } catch (error) {
      warnings.push(
        `Shared DB replica pull skipped: ${(error as Error).message.slice(0, 120)}`,
      );
    }
  }

  return {
    appId,
    linkedDbs,
    ready,
    needsSeed,
    errors,
    warnings,
  };
}

/** After cross-namespace copy: apply pending migrations in the target workspace. */
export async function bootstrapCopiedAppDatabasesInWorkspace(
  appId: string,
  paprHome: string,
): Promise<InstallBootstrapResult> {
  return bootstrapInstalledAppDatabases(appId, {
    installDbPolicy: "fork_empty",
    paprHome: path.resolve(paprHome),
  });
}

/** Agent prompt when install bootstrap is incomplete or needs manual follow-up. */
export function buildCloudInstallAgentSetupMessage(input: {
  appTitle: string;
  appId: string;
  sourceSlug?: string;
  bootstrap: InstallBootstrapResult;
  linkedJobIds?: string[];
}): string {
  const lines: string[] = [
    `The community app "${input.appTitle}" (appId: ${input.appId}` +
      (input.sourceSlug ? `, slug: ${input.sourceSlug}` : "") +
      `) was installed but database setup needs attention.`,
    "",
    "Please complete local setup so reads AND writes work (mini-apps require a local SQLite file; Turso alone is not enough for writes).",
    "",
  ];

  if (input.linkedJobIds && input.linkedJobIds.length > 0) {
    lines.push(
      `Linked job IDs from install: ${input.linkedJobIds.join(", ")}.`,
      "",
    );
  }

  if (input.bootstrap.errors.length > 0) {
    lines.push("**Errors:**");
    for (const err of input.bootstrap.errors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  if (input.bootstrap.linkedDbs.length > 0) {
    lines.push("**Linked databases:**");
    for (const db of input.bootstrap.linkedDbs) {
      lines.push(
        `- alias "${db.alias}": path=${db.localPath || "(unresolved)"}, ` +
          `migrations=[${db.migrationsApplied.join(", ") || "none"}], ` +
          `tables=${db.userTableCount}, turso=${db.tursoPull}, writable=${db.writable}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "**Do this:**",
    "1. Inspect data-sources.json and ~/Papr/data/databases.json — hydrate empty dbPath from registry label/slug if needed.",
    "2. Apply pending migrations under data/databases/{slug}/migrations/*.sql (or Jobs/{id}/migrations for job DBs).",
    "3. If Turso is available, run pull/sync for this app; if remote is empty, run the linked seed/setup job once.",
    "4. Verify POST /api/db/write works for the app before telling the user setup is complete.",
    "5. Open the app tab when done.",
  );

  return lines.join("\n");
}
