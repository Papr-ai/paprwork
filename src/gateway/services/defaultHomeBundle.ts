/**
 * Bundled Home dashboard + Daily Brief job — shared constants and install helpers.
 * Each workspace gets its own Daily Brief job UUID (Turso short name j-{id8}).
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import type { AppDataSource } from "./appDataSources.js";
import {
  canonicalJobDatabasePath,
  isPathWithinWorkspace,
} from "./appDataSources.js";
import type { JobRecord } from "./jobs/types.js";

export const DEFAULT_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
export const DEFAULT_HOME_DAILY_BRIEF_BUNDLED_SLUG = "daily-brief-generator";
export const DEFAULT_HOME_DAILY_BRIEF_JOB_NAME = "Daily Brief Generator";
export const DEFAULT_HOME_JOB_ID_FILE = "default-job-id.txt";

/**
 * Stable data-source alias for the Home briefs database.
 *
 * Must NOT embed the job id. The previous alias was
 * `Daily Brief Generator (${jobId.slice(0,8)})`, which changes per workspace
 * and diverges from the data-source `id` — jobs that hardcoded either string
 * hit "Data source not found", which /api/db/* reports with HTTP 200, so the
 * write silently no-ops and the dashboard goes stale.
 */
export const DEFAULT_HOME_BRIEFS_ALIAS = "briefs";

/** Registry database label for the Home briefs DB (replica-synced). */
export const DEFAULT_HOME_BRIEFS_DB_LABEL = "Home Daily Briefs";

/**
 * Registry slug for the Home briefs database.
 *
 * The DB lives at `$PAPR_HOME/data/databases/home-daily-briefs/data.db` — a
 * real registry database, NOT the job's `data/data.db`. Only paths matching
 * `/data/databases/{slug}/data.db` are recognised by
 * registrySlugFromLocalPath(), get a `d-*` Turso instance, and support
 * `migrations/*.sql`. A job DB registered by path stays a `j-*` instance.
 *
 * Ownership: the Daily Brief job writes it (writeDbIds), the Home app reads it
 * (attached data source). Nobody writes the job's scratch DB.
 */
export const DEFAULT_HOME_BRIEFS_DB_SLUG = "home-daily-briefs";

/** Bundled job assets copied into the job dir on install (source of truth for writes). */
export const DEFAULT_HOME_JOB_ASSETS_DIR = "job-assets";

/** Bundled migrations copied into the registry DB's migrations/ dir on install. */
export const DEFAULT_HOME_DB_MIGRATIONS_DIR = "db-migrations";

/** Legacy fixed UUID from early bundles — migration lookup only. */
export const LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID =
  "2cafb2e9-696b-42db-98fa-5d605977123c";

/** @deprecated Use resolveHomeDailyBriefJobId — kept for existing tests/migrations. */
export const DEFAULT_HOME_DAILY_BRIEF_JOB_ID = LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;

export interface BundledDefaultJobDef {
  bundledSlug?: string;
  id?: string;
  name: string;
  type: JobRecord["type"];
  command?: string;
  schedule?: JobRecord["schedule"];
  retries?: JobRecord["retries"];
  outputMode?: JobRecord["outputMode"];
  memoryPolicy?: JobRecord["memoryPolicy"];
  provider?: string;
  model?: string;
  recipe?: JobRecord["recipe"];
}

export function buildDailyBriefDataSource(
  jobId: string,
  dbPath: string,
  dbId?: string,
): AppDataSource {
  return {
    // id === alias keeps sourceId unambiguous: findDataSource() matches by id
    // first, then alias, so both spellings resolve to this same source.
    id: DEFAULT_HOME_BRIEFS_ALIAS,
    type: "sqlite",
    jobId,
    ...(dbId ? { dbId } : {}),
    alias: DEFAULT_HOME_BRIEFS_ALIAS,
    dbPath,
    tables: ["briefs"],
    linkedAt: new Date().toISOString(),
  };
}

/**
 * Refresh dbPath/jobId on an existing Daily Brief link without rewriting alias/id
 * when the same job is already linked. Gateway startup re-ran installDefaultJob
 * on every boot and spread buildDailyBriefDataSource(), renaming aliases out from
 * under mini-apps that queried by sourceId.
 */
export function mergeDailyBriefDataSource(
  existing: AppDataSource | undefined,
  jobId: string,
  dbPath: string,
  dbId?: string,
): AppDataSource {
  const canonical = buildDailyBriefDataSource(jobId, dbPath, dbId);

  if (!existing) {
    return canonical;
  }

  const existingJobId = existing.jobId?.trim();
  if (existingJobId && existingJobId !== jobId) {
    return {
      ...canonical,
      linkedAt: existing.linkedAt ?? canonical.linkedAt,
    };
  }

  const alias = existing.alias?.trim();
  const id = existing.id?.trim();

  return {
    ...existing,
    type: existing.type ?? canonical.type,
    jobId,
    // Bind to the registry database once provisioned; never drop an existing id.
    ...(dbId ?? existing.dbId ? { dbId: dbId ?? existing.dbId } : {}),
    dbPath,
    tables: existing.tables?.length ? existing.tables : canonical.tables,
    alias: alias || canonical.alias,
    id: id || canonical.id,
  };
}

export function dailyBriefDataSourceNeedsUpdate(
  before: AppDataSource,
  after: AppDataSource,
): boolean {
  return (
    before.dbPath !== after.dbPath ||
    before.jobId !== after.jobId ||
    before.alias !== after.alias ||
    before.id !== after.id ||
    before.dbId !== after.dbId
  );
}

function isHomeDailyBriefRegistryJob(job: JobRecord): boolean {
  if (job.id.endsWith(".migrated")) {
    return false;
  }
  if (
    job.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME &&
    job.appIds?.includes(DEFAULT_HOME_APP_ID)
  ) {
    return true;
  }
  return job.id === LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
}

export function findHomeDailyBriefJobIdInRegistry(
  jobs: Iterable<JobRecord>,
  options?: { preferJobId?: string },
): string | undefined {
  const prefer = options?.preferJobId?.trim();
  if (prefer) {
    for (const job of jobs) {
      if (job.id === prefer && isHomeDailyBriefRegistryJob(job)) {
        return prefer;
      }
    }
  }

  const linked: JobRecord[] = [];
  for (const job of jobs) {
    if (isHomeDailyBriefRegistryJob(job)) {
      linked.push(job);
    }
  }

  if (linked.length === 0) {
    return undefined;
  }

  const nonLegacy = linked.filter(
    (job) => job.id !== LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  );
  if (nonLegacy.length === 1) {
    return nonLegacy[0].id;
  }
  if (nonLegacy.length > 1) {
    if (prefer) {
      const match = nonLegacy.find((job) => job.id === prefer);
      if (match) {
        return match.id;
      }
    }
    return nonLegacy[0].id;
  }

  return linked[0]?.id;
}

export async function readHomeDailyBriefJobIdFromAppDir(
  appDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(appDir, DEFAULT_HOME_JOB_ID_FILE),
      "utf8",
    );
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeHomeDailyBriefJobIdToAppDir(
  appDir: string,
  jobId: string,
): Promise<void> {
  await fs.writeFile(
    path.join(appDir, DEFAULT_HOME_JOB_ID_FILE),
    `${jobId.trim()}\n`,
    "utf8",
  );
}

export function resolveHomeDailyBriefJobId(params: {
  appDir: string;
  jobIdFromFile?: string;
  jobExists: (jobId: string) => boolean;
  findLinkedJobId?: () => string | undefined;
}): string | undefined {
  const fromFile = params.jobIdFromFile?.trim();
  if (fromFile && params.jobExists(fromFile)) {
    return fromFile;
  }

  if (params.jobExists(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID)) {
    return LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
  }

  const linked = params.findLinkedJobId?.();
  if (linked && params.jobExists(linked)) {
    return linked;
  }

  return undefined;
}

export async function resolveOrAllocateHomeDailyBriefJobId(params: {
  appDir: string;
  jobExists: (jobId: string) => boolean;
  findLinkedJobId?: () => string | undefined;
}): Promise<string> {
  const fromFile = await readHomeDailyBriefJobIdFromAppDir(params.appDir);
  const existing = resolveHomeDailyBriefJobId({
    appDir: params.appDir,
    jobIdFromFile: fromFile,
    jobExists: params.jobExists,
    findLinkedJobId: params.findLinkedJobId,
  });
  if (existing) {
    await writeHomeDailyBriefJobIdToAppDir(params.appDir, existing);
    return existing;
  }

  const jobId = randomUUID();
  await writeHomeDailyBriefJobIdToAppDir(params.appDir, jobId);
  return jobId;
}

export function shouldRewriteDailyBriefDbPath(params: {
  storedDbPath: string | undefined;
  resolvedDbPath: string;
  workspaceRoot: string;
}): boolean {
  const stored = params.storedDbPath?.trim() ?? "";
  if (stored.length === 0) {
    return existsSync(params.resolvedDbPath);
  }

  const normalizedStored = path.normalize(stored);
  const normalizedResolved = path.normalize(params.resolvedDbPath);
  if (normalizedStored === normalizedResolved) {
    return false;
  }

  if (!isPathWithinWorkspace(stored, params.workspaceRoot)) {
    return existsSync(params.resolvedDbPath);
  }

  return false;
}

export function resolveDailyBriefDbPath(
  jobsRoot: string,
  jobId: string,
): string {
  return canonicalJobDatabasePath(jobsRoot, jobId);
}
