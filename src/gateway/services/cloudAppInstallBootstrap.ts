/**
 * Post-install bootstrap for cloud/community mini-apps:
 * resolve linked DB paths, apply git migrations locally, optional Turso row pull.
 */

import { existsSync, statSync } from "fs";
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
    db = new Database(dbPath, { readonly: true });
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
): Promise<string[]> {
  if (source.dbId && !source.jobId) {
    return applyRegistryDatabaseMigrations(localPath);
  }
  if (source.jobId) {
    const jobDir = path.join(getPaprJobsRoot(), source.jobId);
    return applyDatabaseMigrations(jobDir, localPath);
  }
  return applyRegistryDatabaseMigrations(localPath);
}

async function bootstrapLinkedSource(
  source: AppDataSource,
  tursoSummary: SyncSummary | null,
  pullResults: Map<string, PullResult | undefined>,
): Promise<LinkedDbBootstrapResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const localPath = await resolveLinkedSourceDbPath({
    dbPath: source.dbPath,
    dbId: source.dbId,
    jobId: source.jobId,
    jobsRoot: getPaprJobsRoot(),
  });

  if (!localPath?.trim()) {
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

  let migrationsApplied: string[] = [];
  try {
    migrationsApplied = await applyMigrationsForSource(source, localPath);
  } catch (error) {
    errors.push(
      `Migration failed for "${source.alias}" at ${localPath}: ${(error as Error).message}`,
    );
  }

  const syncKey = source.dbId ?? source.jobId ?? localPath;
  const tursoPull = mapTursoPullOutcome(tursoSummary, syncKey, pullResults);

  if (tursoPull === "unavailable") {
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

  const userTableCount = countUserTables(localPath);
  const writable = isLocalDbReadable(localPath);

  if (!writable && errors.length === 0) {
    errors.push(
      `Local database not readable at ${localPath} after bootstrap.`,
    );
  }

  if (writable && userTableCount === 0 && errors.length === 0) {
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

async function readAppDataSources(appId: string): Promise<AppDataSource[]> {
  const configPath = path.join(getPaprAppsRoot(), appId, "data-sources.json");
  const { readFile } = await import("fs/promises");
  const raw = await readFile(configPath, "utf8");
  return parseDataSourcesFile(raw).sources;
}

/** Apply migrations + optional Turso pull for one installed app. */
export async function bootstrapInstalledAppDatabases(
  appId: string,
): Promise<InstallBootstrapResult> {
  const sources = await readAppDataSources(appId);
  const linkedDbs: LinkedDbBootstrapResult[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

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

  try {
    const { ensureTursoSyncBridge, syncTursoAfterAppInstall } = await import(
      "./TursoSyncBridge.js"
    );
    ensureTursoSyncBridge();
    tursoSummary = await syncTursoAfterAppInstall(appId);
    for (const entry of tursoSummary.results) {
      pullResults.set(entry.jobId, entry.pull);
    }
  } catch (error) {
    warnings.push(
      `Turso bootstrap skipped: ${(error as Error).message.slice(0, 160)}`,
    );
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
    const result = await bootstrapLinkedSource(source, tursoSummary, pullResults);
    linkedDbs.push(result);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  const ready =
    linkedDbs.length > 0 &&
    linkedDbs.every((db) => db.writable && db.errors.length === 0);
  const needsSeed =
    ready && linkedDbs.some((db) => db.userTableCount === 0);

  return {
    appId,
    linkedDbs,
    ready,
    needsSeed,
    errors,
    warnings,
  };
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
