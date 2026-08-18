/**
 * One-time migration: re-home the bundled Daily Brief job from the shared legacy
 * UUID (2cafb2e9…) to a namespace-owned UUID so git/Turso sync keys are unique
 * per workspace.
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
} from "./appDataSources.js";
import {
  buildDailyBriefDataSource,
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
  LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  readHomeDailyBriefJobIdFromAppDir,
  resolveDailyBriefDbPath,
  writeHomeDailyBriefJobIdToAppDir,
} from "./defaultHomeBundle.js";
import type { JobRecord } from "./jobs/types.js";
import {
  loadConvergenceState,
  saveConvergenceState,
  type ConvergenceStateFile,
} from "./cloudSync/convergenceChecker.js";
import {
  loadTursoSyncState,
  saveTursoSyncState,
  type TursoSyncStateFile,
} from "./tursoSyncState.js";
import {
  DATABASES_REGISTRY_FILENAME,
  type DatabasesRegistryFile,
} from "./DatabaseRegistryService.js";

export const LEGACY_HOME_JOB_MIGRATION_MARKER = ".legacy-home-job-migration.json";

export interface LegacyHomeJobMigrationMarker {
  fromJobId: string;
  toJobId: string;
  migratedAt: string;
}

export interface LegacyHomeJobMigrationResult {
  migrated: boolean;
  fromJobId?: string;
  toJobId?: string;
  reason?: string;
}

export interface LegacyHomeJobMigrationDeps {
  paprDir: string;
  appsDir: string;
  jobsRoot: string;
  jobs: Map<string, JobRecord>;
  saveJobs: () => Promise<void>;
  persistJobRecord: (job: JobRecord) => Promise<void>;
}

function markerPath(paprDir: string): string {
  return path.join(paprDir, "data", LEGACY_HOME_JOB_MIGRATION_MARKER);
}

async function readMigrationMarker(
  paprDir: string,
): Promise<LegacyHomeJobMigrationMarker | null> {
  try {
    const raw = await fs.readFile(markerPath(paprDir), "utf8");
    const parsed = JSON.parse(raw) as LegacyHomeJobMigrationMarker;
    if (parsed?.fromJobId && parsed?.toJobId && parsed?.migratedAt) {
      return parsed;
    }
  } catch {
    /* not migrated yet */
  }
  return null;
}

async function writeMigrationMarker(
  paprDir: string,
  marker: LegacyHomeJobMigrationMarker,
): Promise<void> {
  const target = markerPath(paprDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function isHomeDailyBriefJob(job: JobRecord): boolean {
  if (job.id !== LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID) {
    return false;
  }
  if (job.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME) {
    return true;
  }
  return job.appIds?.includes(DEFAULT_HOME_APP_ID) ?? false;
}

function remapTursoJobState(
  state: TursoSyncStateFile,
  fromKey: string,
  toKey: string,
  newDbPath: string,
): boolean {
  const entry = state.jobs[fromKey];
  if (!entry) {
    return false;
  }
  delete state.jobs[fromKey];
  state.jobs[toKey] = { ...entry, dbPath: newDbPath };
  return true;
}

function remapConvergenceSource(
  state: ConvergenceStateFile,
  fromKey: string,
  toKey: string,
): boolean {
  const entry = state.sources[fromKey];
  if (!entry) {
    return false;
  }
  delete state.sources[fromKey];
  state.sources[toKey] = { ...entry, syncKey: toKey };
  return true;
}

async function migrateDatabasesRegistry(
  paprDir: string,
  fromJobId: string,
  toJobId: string,
  newDbPath: string,
): Promise<boolean> {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, "utf8");
  } catch {
    return false;
  }

  let registry: DatabasesRegistryFile;
  try {
    registry = JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return false;
  }

  let changed = false;
  for (const record of Object.values(registry.databases ?? {})) {
    if (record.ownerJobId === fromJobId) {
      record.ownerJobId = toJobId;
      record.localPath = newDbPath;
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
  return changed;
}

async function migrateJobRunHistory(
  paprDir: string,
  fromJobId: string,
  toJobId: string,
): Promise<boolean> {
  const historyPath = path.join(paprDir, "data", "job-runs.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(historyPath, "utf8");
  } catch {
    return false;
  }

  if (!raw.includes(fromJobId)) {
    return false;
  }

  const lines = raw.split("\n");
  let changed = false;
  const next = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    try {
      const entry = JSON.parse(line) as { jobId?: string };
      if (entry.jobId === fromJobId) {
        changed = true;
        return JSON.stringify({ ...entry, jobId: toJobId });
      }
    } catch {
      /* keep line */
    }
    return line;
  });

  if (changed) {
    await fs.writeFile(historyPath, next.join("\n"), "utf8");
  }
  return changed;
}

function rewriteJobCrossReferences(
  jobs: Map<string, JobRecord>,
  fromJobId: string,
  toJobId: string,
): boolean {
  let changed = false;
  for (const [id, job] of jobs.entries()) {
    if (id === fromJobId) {
      continue;
    }

    let jobChanged = false;
    const next = { ...job };

    if (next.dependsOn?.some((dep) => dep.jobId === fromJobId)) {
      next.dependsOn = next.dependsOn.map((dep) =>
        dep.jobId === fromJobId ? { ...dep, jobId: toJobId } : dep,
      );
      jobChanged = true;
    }

    if (next.runtimeCalls?.includes(fromJobId)) {
      next.runtimeCalls = next.runtimeCalls.map((callId) =>
        callId === fromJobId ? toJobId : callId,
      );
      jobChanged = true;
    }

    if (jobChanged) {
      jobs.set(id, next);
      changed = true;
    }
  }
  return changed;
}

async function updateHomeAppDataSources(
  appDir: string,
  fromJobId: string,
  toJobId: string,
  newDbPath: string,
): Promise<boolean> {
  const dsPath = path.join(appDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(dsPath, "utf8");
  } catch {
    return false;
  }

  let config;
  try {
    config = parseDataSourcesFile(raw);
  } catch {
    return false;
  }

  let changed = false;
  const nextSource = buildDailyBriefDataSource(
    toJobId,
    existsSync(newDbPath) ? newDbPath : "",
  );

  const sources = (config.sources ?? []).map((source) => {
    const jobId = source.jobId?.trim();
    const isBrief =
      source.tables?.includes("briefs") ||
      jobId === fromJobId ||
      source.id?.startsWith(`${fromJobId}:`);

    if (!isBrief) {
      return source;
    }

    changed = true;
    return {
      ...source,
      ...nextSource,
      dbPath: existsSync(newDbPath) ? newDbPath : source.dbPath ?? "",
    };
  });

  const hasBrief = sources.some(
    (source) =>
      source.jobId === toJobId && source.tables?.includes("briefs"),
  );
  if (!hasBrief) {
    sources.unshift(nextSource);
    changed = true;
  }

  if (changed) {
    await fs.writeFile(
      dsPath,
      serializeDataSourcesFile({ ...config, sources }),
      "utf8",
    );
  }

  await writeHomeDailyBriefJobIdToAppDir(appDir, toJobId);
  return changed;
}

async function copyLegacyJobFolder(
  jobsRoot: string,
  fromJobId: string,
  toJobId: string,
): Promise<boolean> {
  const legacyDir = path.join(jobsRoot, fromJobId);
  const targetDir = path.join(jobsRoot, toJobId);

  if (existsSync(targetDir)) {
    return false;
  }

  if (!existsSync(legacyDir)) {
    return false;
  }

  await fs.cp(legacyDir, targetDir, { recursive: true });
  return true;
}

async function archiveLegacyJobFolder(
  jobsRoot: string,
  fromJobId: string,
): Promise<void> {
  const legacyDir = path.join(jobsRoot, fromJobId);
  if (!existsSync(legacyDir)) {
    return;
  }
  const archived = path.join(jobsRoot, `${fromJobId}.migrated`);
  if (existsSync(archived)) {
    await fs.rm(legacyDir, { recursive: true, force: true });
    return;
  }
  await fs.rename(legacyDir, archived);
}

export async function migrateLegacyHomeDailyBriefJobIfNeeded(
  deps: LegacyHomeJobMigrationDeps,
): Promise<LegacyHomeJobMigrationResult> {
  const legacyId = LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
  const homeAppDir = path.join(deps.appsDir, DEFAULT_HOME_APP_ID);
  const jobIdFromFile = await readHomeDailyBriefJobIdFromAppDir(homeAppDir);

  const existingMarker = await readMigrationMarker(deps.paprDir);
  if (existingMarker) {
    if (
      jobIdFromFile === existingMarker.toJobId &&
      deps.jobs.has(existingMarker.toJobId)
    ) {
      return { migrated: false, reason: "already_migrated" };
    }
  }

  if (
    jobIdFromFile &&
    jobIdFromFile !== legacyId &&
    deps.jobs.has(jobIdFromFile)
  ) {
    return { migrated: false, reason: "namespace_job_already_assigned" };
  }

  const legacyJob = deps.jobs.get(legacyId);
  const legacyDirExists = existsSync(path.join(deps.jobsRoot, legacyId));

  if (!legacyJob && !legacyDirExists) {
    return { migrated: false, reason: "no_legacy_job" };
  }

  if (legacyJob && !isHomeDailyBriefJob(legacyJob)) {
    return { migrated: false, reason: "legacy_id_not_home_daily_brief" };
  }

  const toJobId =
    jobIdFromFile && jobIdFromFile !== legacyId ? jobIdFromFile : randomUUID();
  const newDbPath = resolveDailyBriefDbPath(deps.jobsRoot, toJobId);
  const now = new Date().toISOString();

  await copyLegacyJobFolder(deps.jobsRoot, legacyId, toJobId);

  const baseJob: JobRecord =
    legacyJob ??
    ({
      id: legacyId,
      name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
      type: "agent",
      status: "pending",
      appIds: [DEFAULT_HOME_APP_ID],
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    } satisfies JobRecord);

  const migratedJob: JobRecord = {
    ...baseJob,
    id: toJobId,
    appIds: baseJob.appIds?.length
      ? baseJob.appIds
      : [DEFAULT_HOME_APP_ID],
    updatedAt: now,
  };

  deps.jobs.delete(legacyId);
  deps.jobs.set(toJobId, migratedJob);

  rewriteJobCrossReferences(deps.jobs, legacyId, toJobId);

  await deps.persistJobRecord(migratedJob);
  await deps.saveJobs();

  if (existsSync(homeAppDir)) {
    await updateHomeAppDataSources(homeAppDir, legacyId, toJobId, newDbPath);
  }

  const tursoState = loadTursoSyncState(deps.paprDir);
  if (remapTursoJobState(tursoState, legacyId, toJobId, newDbPath)) {
    saveTursoSyncState(tursoState, deps.paprDir);
  }

  const convergenceState = loadConvergenceState(deps.paprDir);
  if (remapConvergenceSource(convergenceState, legacyId, toJobId)) {
    saveConvergenceState(convergenceState, deps.paprDir);
  }

  await migrateDatabasesRegistry(deps.paprDir, legacyId, toJobId, newDbPath);
  await migrateJobRunHistory(deps.paprDir, legacyId, toJobId);

  await archiveLegacyJobFolder(deps.jobsRoot, legacyId);

  await writeMigrationMarker(deps.paprDir, {
    fromJobId: legacyId,
    toJobId,
    migratedAt: now,
  });

  return { migrated: true, fromJobId: legacyId, toJobId };
}
