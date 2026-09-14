/**
 * Copy a mini-app bundle (app + linked jobs + DB registry) into another namespace.
 * Source namespace is left unchanged — delete locally if you no longer want it there.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  readActiveWorkspacePointer,
  resolveOrgNamespaceWorkspacePath,
} from "../../core/utils/paprWorkspace.js";
import type { MiniApp } from "./AppService.js";
import { ensureUniqueAppTitle } from "../utils/uniqueAppNaming.js";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
  type AppDataSourcesFile,
} from "./appDataSources.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";
import { mergeJobAppIds } from "./jobs/appIds.js";
import type { JobRecord } from "./jobs/types.js";
import type { DatabasesRegistryFile, DatabaseRecord } from "./DatabaseRegistryService.js";
import { newDbId } from "./DatabaseRegistryService.js";
import { dbTursoDatabaseName } from "./tursoDatabaseNaming.js";
import type { InstallDbPolicy } from "./cloudInstallDbPolicy.js";
import { LINKED_DATABASES_FILENAME } from "./cloudSync/linkedDatabasesForCloud.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import {
  ensureRegistryDbInWorkspace,
  extractDatabaseSlugFromPath,
  isReadableDbFile,
  resolveReadableRegistryDbPath,
  workspaceRegistryDbPath,
} from "./resolveRegistryDbPath.js";
import { isUnreadableDbPath } from "./portableDataSources.js";
import { writeCloudAppMetadataFile } from "./cloudAppMetadataFile.js";

export interface CopyAppToNamespaceInput {
  appId: string;
  targetOrganizationId: string;
  targetNamespaceId: string;
  sourcePaprHome: string;
}

export interface CopyAppToNamespaceResult {
  appId: string;
  title: string;
  sourceNamespaceId: string;
  targetNamespaceId: string;
  titleRenamed: boolean;
  copiedJobIds: string[];
  skippedJobIds: string[];
  copiedRegistryDbSlugs: string[];
}

export class CopyAppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CopyAppError";
    this.code = code;
  }
}

async function readAppsIndex(indexPath: string): Promise<MiniApp[]> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as MiniApp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAppsIndex(indexPath: string, apps: MiniApp[]): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(apps, null, 2), "utf8");
  await fs.rename(tmpPath, indexPath);
}

async function readJobsIndex(indexPath: string): Promise<JobRecord[]> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as JobRecord[] | { jobs?: JobRecord[] };
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.jobs ?? [];
  } catch {
    return [];
  }
}

async function writeJobsIndex(indexPath: string, jobs: JobRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(jobs, null, 2), "utf8");
  await fs.rename(tmpPath, indexPath);
}

async function readDatabasesRegistry(
  indexPath: string,
): Promise<DatabasesRegistryFile> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as DatabasesRegistryFile;
    if (parsed?.databases && typeof parsed.databases === "object") {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { version: 1, databases: {} };
}

async function writeDatabasesRegistry(
  indexPath: string,
  registry: DatabasesRegistryFile,
): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf8");
  await fs.rename(tmpPath, indexPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function jobDatabasePath(paprHome: string, jobId: string): string {
  return path.join(paprHome, "Jobs", jobId, "data", "data.db");
}

const JOB_LOCAL_DB_REL = path.join("data", "data.db");

async function copyJobDirectory(input: {
  sourceJobDir: string;
  targetJobDir: string;
  preserveLocalDatabase: boolean;
}): Promise<void> {
  if (!input.preserveLocalDatabase) {
    await fs.cp(input.sourceJobDir, input.targetJobDir, { recursive: true });
    return;
  }

  async function walk(relativeDir: string): Promise<void> {
    const currentSource = path.join(input.sourceJobDir, relativeDir);
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;
      if (rel.replace(/\\/g, "/") === JOB_LOCAL_DB_REL.replace(/\\/g, "/")) {
        continue;
      }
      const src = path.join(input.sourceJobDir, rel);
      const dest = path.join(input.targetJobDir, rel);
      if (entry.isDirectory()) {
        await fs.mkdir(dest, { recursive: true });
        await walk(rel);
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  await fs.mkdir(input.targetJobDir, { recursive: true });
  await walk("");
}

async function replaceJobDirectoryPreservingDatabase(input: {
  sourceJobDir: string;
  targetJobDir: string;
  preserveLocalDatabase: boolean;
}): Promise<void> {
  if (!input.preserveLocalDatabase) {
    await fs.rm(input.targetJobDir, { recursive: true, force: true });
    await copyJobDirectory(input);
    return;
  }

  const localDbPath = path.join(input.targetJobDir, JOB_LOCAL_DB_REL);
  let preservedDb: Buffer | null = null;
  if (await pathExists(localDbPath)) {
    preservedDb = await fs.readFile(localDbPath);
  }

  await fs.rm(input.targetJobDir, { recursive: true, force: true });
  await copyJobDirectory(input);

  if (preservedDb) {
    const restorePath = path.join(input.targetJobDir, JOB_LOCAL_DB_REL);
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.writeFile(restorePath, preservedDb);
  }
}

function prepareCopiedJobRecord(
  sourceJob: JobRecord,
  appId: string,
  copiedJobIds: ReadonlySet<string>,
): JobRecord {
  const dependsOn = (sourceJob.dependsOn ?? []).filter((dep) =>
    copiedJobIds.has(dep.jobId),
  );
  const runtimeCalls = (sourceJob.runtimeCalls ?? []).filter((calleeId) =>
    copiedJobIds.has(calleeId),
  );

  return {
    ...sourceJob,
    appIds: [appId],
    dependsOn,
    runtimeCalls,
    status: "pending",
    lastRunAt: undefined,
    completedAt: undefined,
    exitCode: undefined,
    error: undefined,
    currentExecutionId: undefined,
    lastExecutionId: undefined,
    currentAttempt: undefined,
    nextRetryAt: undefined,
    lastOutput: undefined,
    waitingPermissionKeys: undefined,
    waitingScheduleRisk: undefined,
    updatedAt: new Date().toISOString(),
  };
}

async function rewriteDataSourcesForTarget(
  targetAppDir: string,
  targetPaprHome: string,
): Promise<void> {
  const configPath = path.join(targetAppDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }

  const targetDataDir = path.join(targetPaprHome, "data");
  const config = parseDataSourcesFile(raw);
  const sources = config.sources.map((source) => {
    if (source.jobId) {
      return {
        ...source,
        dbPath: jobDatabasePath(targetPaprHome, source.jobId),
      };
    }
    const jobMatch = source.dbPath?.match(
      /[/\\]Jobs[/\\]([0-9a-f-]{36})[/\\]data[/\\]/i,
    );
    if (jobMatch?.[1]) {
      return {
        ...source,
        dbPath: jobDatabasePath(targetPaprHome, jobMatch[1]),
      };
    }

    const slug = extractDatabaseSlugFromPath(source.dbPath ?? "");
    if (slug) {
      return {
        ...source,
        dbPath: workspaceRegistryDbPath(slug, targetDataDir),
      };
    }

    if (source.dbId && isUnreadableDbPath(source.dbPath)) {
      return { ...source, dbPath: "" };
    }

    return source;
  });

  const next: AppDataSourcesFile = { sources };
  await fs.writeFile(configPath, serializeDataSourcesFile(next), "utf8");
}

async function hydrateDataSourcesFromRegistry(
  targetAppDir: string,
  targetRegistryPath: string,
  targetPaprHome: string,
): Promise<void> {
  const configPath = path.join(targetAppDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }

  const registry = await readDatabasesRegistry(targetRegistryPath);
  const targetDataDir = path.join(targetPaprHome, "data");
  const config = parseDataSourcesFile(raw);
  let changed = false;
  const sources = config.sources.map((source) => {
    if (source.jobId || !source.dbId) {
      return source;
    }
    const record = registry.databases[source.dbId];
    let registryPath = record?.localPath?.trim() ?? "";
    if (!registryPath && record) {
      const slug = resolveRegistrySlug(record);
      if (slug) {
        registryPath = workspaceRegistryDbPath(slug, targetDataDir);
      }
    }
    if (!registryPath) {
      return source;
    }
    if (source.dbPath?.trim() === registryPath) {
      return source;
    }
    changed = true;
    return { ...source, dbPath: registryPath };
  });

  if (!changed) {
    return;
  }

  await fs.writeFile(
    configPath,
    serializeDataSourcesFile({ sources }),
    "utf8",
  );
}

function collectRegistryDbIds(
  jobs: JobRecord[],
  copiedJobIds: ReadonlySet<string>,
): Set<string> {
  const dbIds = new Set<string>();
  for (const job of jobs) {
    if (!copiedJobIds.has(job.id)) {
      continue;
    }
    for (const dbId of job.writeDbIds ?? []) {
      dbIds.add(dbId);
    }
  }
  return dbIds;
}

function slugifyRegistryLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "database";
}

function resolveRegistrySlug(record: DatabaseRecord): string | null {
  const fromPath = extractDatabaseSlugFromPath(record.localPath ?? "");
  if (fromPath) {
    return fromPath;
  }
  const label = record.label?.trim();
  if (label) {
    return slugifyRegistryLabel(label);
  }
  return null;
}

function resolveCopiedRegistryLocalPath(
  record: DatabaseRecord,
  targetPaprHome: string,
  copiedJobIds: ReadonlySet<string>,
): string {
  const ownerJobId = record.ownerJobId;
  if (ownerJobId && copiedJobIds.has(ownerJobId)) {
    return jobDatabasePath(targetPaprHome, ownerJobId);
  }
  const slug = resolveRegistrySlug(record);
  if (slug) {
    return workspaceRegistryDbPath(slug, path.join(targetPaprHome, "data"));
  }
  return record.localPath;
}

async function readLinkedDatabasesAt(
  appDir: string,
): Promise<DatabasesRegistryFile> {
  try {
    const raw = await fs.readFile(
      path.join(appDir, LINKED_DATABASES_FILENAME),
      "utf8",
    );
    const parsed = JSON.parse(raw) as DatabasesRegistryFile;
    if (parsed?.databases && typeof parsed.databases === "object") {
      return parsed;
    }
  } catch {
    /* no linked-databases.json */
  }
  return { version: 1, databases: {} };
}

async function collectLinkedRegistryDbIds(appDir: string): Promise<Set<string>> {
  const dbIds = new Set<string>();
  try {
    const raw = await fs.readFile(
      path.join(appDir, "data-sources.json"),
      "utf8",
    );
    const config = parseDataSourcesFile(raw);
    for (const source of config.sources) {
      if (source.dbId) {
        dbIds.add(source.dbId);
      }
    }
  } catch {
    /* no data sources */
  }
  return dbIds;
}

function stripReplicaSyncFields(
  record: DatabaseRecord,
): Omit<
  DatabaseRecord,
  | "cutoverAt"
  | "cutoverInProgress"
  | "cutoverStartedAt"
  | "cutoverBlocked"
  | "cutoverBlockReason"
  | "lastReplicaPushError"
  | "lastReplicaPushAt"
  | "lastReplicaLocalMutationAt"
> {
  const {
    cutoverAt: _cutoverAt,
    cutoverInProgress: _cutoverInProgress,
    cutoverStartedAt: _cutoverStartedAt,
    cutoverBlocked: _cutoverBlocked,
    cutoverBlockReason: _cutoverBlockReason,
    lastReplicaPushError: _lastReplicaPushError,
    lastReplicaPushAt: _lastReplicaPushAt,
    lastReplicaLocalMutationAt: _lastReplicaLocalMutationAt,
    ...rest
  } = record;
  return rest;
}

export async function applyDbIdRemapToAppFiles(
  appDir: string,
  dbIdRemap: ReadonlyMap<string, string>,
): Promise<void> {
  if (dbIdRemap.size === 0) {
    return;
  }

  const configPath = path.join(appDir, "data-sources.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const config = parseDataSourcesFile(raw);
    let changed = false;
    const sources = config.sources.map((source) => {
      if (!source.dbId || !dbIdRemap.has(source.dbId)) {
        return source;
      }
      const newDbId = dbIdRemap.get(source.dbId)!;
      changed = true;
      const nextId =
        source.id === source.dbId
          ? newDbId
          : source.id.replace(source.dbId, newDbId);
      return { ...source, dbId: newDbId, id: nextId };
    });
    if (changed) {
      await fs.writeFile(
        configPath,
        serializeDataSourcesFile({ ...config, sources }),
        "utf8",
      );
    }
  } catch {
    /* no data-sources.json */
  }

  const linkedPath = path.join(appDir, LINKED_DATABASES_FILENAME);
  try {
    const linked = await readLinkedDatabasesAt(appDir);
    const nextDatabases: Record<string, DatabaseRecord> = {};
    let linkedChanged = false;
    for (const [key, record] of Object.entries(linked.databases)) {
      const mappedKey = dbIdRemap.get(key) ?? key;
      const mappedDbId = dbIdRemap.get(record.dbId) ?? record.dbId;
      if (mappedKey !== key || mappedDbId !== record.dbId) {
        linkedChanged = true;
      }
      nextDatabases[mappedKey] = {
        ...record,
        dbId: mappedDbId,
        tursoShortName: dbTursoDatabaseName(mappedDbId),
      };
    }
    if (linkedChanged) {
      await fs.writeFile(
        linkedPath,
        JSON.stringify({ version: 1, databases: nextDatabases }, null, 2),
        "utf8",
      );
    }
  } catch {
    /* no linked-databases.json */
  }
}

async function copyRegistryDatabaseFiles(input: {
  sourcePaprHome: string;
  targetPaprHome: string;
  sourceRegistryPath: string;
  targetRegistryPath: string;
  dbIds: ReadonlySet<string>;
  copiedJobIds: ReadonlySet<string>;
  /** Fork: copy migrations only — never publisher data.db bytes. */
  schemaOnly?: boolean;
}): Promise<string[]> {
  const sourceRegistry = await readDatabasesRegistry(input.sourceRegistryPath);
  const targetRegistry = await readDatabasesRegistry(input.targetRegistryPath);
  const sourceDataDir = path.join(input.sourcePaprHome, "data");
  const targetDataDir = path.join(input.targetPaprHome, "data");
  const copiedSlugs: string[] = [];

  for (const dbId of input.dbIds) {
    const record =
      sourceRegistry.databases[dbId] ?? targetRegistry.databases[dbId];
    if (!record) {
      continue;
    }

    if (record.ownerJobId && input.copiedJobIds.has(record.ownerJobId)) {
      continue;
    }

    const slug = resolveRegistrySlug(record);
    if (!slug) {
      continue;
    }

    const targetPath = workspaceRegistryDbPath(slug, targetDataDir);
    const sourcePath = resolveReadableRegistryDbPath({
      dbPath: sourceRegistry.databases[dbId]?.localPath,
      registryPath: sourceRegistry.databases[dbId]?.localPath,
      dataDir: sourceDataDir,
    });
    const sourceSlugDir = path.join(sourceDataDir, "databases", slug);
    const targetSlugDir = path.join(targetDataDir, "databases", slug);

    if (await pathExists(sourceSlugDir)) {
      if (!(await pathExists(targetSlugDir))) {
        await fs.mkdir(path.dirname(targetSlugDir), { recursive: true });
        if (input.schemaOnly) {
          const migrationsDir = path.join(sourceSlugDir, "migrations");
          if (await pathExists(migrationsDir)) {
            await fs.cp(
              migrationsDir,
              path.join(targetSlugDir, "migrations"),
              { recursive: true },
            );
          }
        } else {
          await fs.cp(sourceSlugDir, targetSlugDir, { recursive: true });
        }
        copiedSlugs.push(slug);
        continue;
      }
    }

    if (
      !input.schemaOnly &&
      sourcePath &&
      (await ensureRegistryDbInWorkspace({ sourcePath, targetPath }))
    ) {
      copiedSlugs.push(slug);
      continue;
    }

    if (isReadableDbFile(targetPath)) {
      copiedSlugs.push(slug);
    }
  }

  return copiedSlugs;
}

export async function mergeDatabaseRegistryForCopy(input: {
  sourceRegistryPath: string;
  targetRegistryPath: string;
  targetPaprHome: string;
  copiedJobIds: ReadonlySet<string>;
  dbIdsFromJobs: Set<string>;
  appDir: string;
  sourceAppDir?: string;
  /** Fork install: mint new dbId per linked registry database. */
  forkDbIds?: boolean;
  localAppId?: string;
}): Promise<{ registryDbIds: Set<string>; dbIdRemap: Map<string, string> }> {
  const sourceRegistry = await readDatabasesRegistry(input.sourceRegistryPath);
  const targetRegistry = await readDatabasesRegistry(input.targetRegistryPath);
  const linkedFromTargetApp = await readLinkedDatabasesAt(input.appDir);
  const linkedFromSourceApp = input.sourceAppDir
    ? await readLinkedDatabasesAt(input.sourceAppDir)
    : { version: 1 as const, databases: {} };
  const dbIds = new Set(input.dbIdsFromJobs);

  for (const sourceDbId of await collectLinkedRegistryDbIds(input.appDir)) {
    dbIds.add(sourceDbId);
  }

  const merged: DatabasesRegistryFile = {
    version: 1,
    databases: { ...targetRegistry.databases },
  };
  const dbIdRemap = new Map<string, string>();
  const registryDbIds = new Set<string>();

  for (const dbId of dbIds) {
    const record =
      sourceRegistry.databases[dbId] ??
      linkedFromSourceApp.databases[dbId] ??
      linkedFromTargetApp.databases[dbId] ??
      targetRegistry.databases[dbId];
    if (!record) {
      continue;
    }

    const ownerJobId = record.ownerJobId;
    if (ownerJobId && input.copiedJobIds.has(ownerJobId)) {
      const localPath = resolveCopiedRegistryLocalPath(
        record,
        input.targetPaprHome,
        input.copiedJobIds,
      );
      const existing = merged.databases[dbId];
      merged.databases[dbId] = {
        ...(existing ?? record),
        localPath,
        updatedAt: new Date().toISOString(),
      };
      registryDbIds.add(dbId);
      continue;
    }

    const targetDbId =
      input.forkDbIds && !ownerJobId ? newDbId() : dbId;
    if (targetDbId !== dbId) {
      dbIdRemap.set(dbId, targetDbId);
    }

    const localPath = resolveCopiedRegistryLocalPath(
      record,
      input.targetPaprHome,
      input.copiedJobIds,
    );
    const existing = merged.databases[dbId];
    const base = stripReplicaSyncFields(existing ?? record);
    const { syncMode: _forkOmitSyncMode, ...forkLocalBase } = base;
    merged.databases[targetDbId] = {
      ...(input.forkDbIds ? forkLocalBase : base),
      dbId: targetDbId,
      tursoShortName: dbTursoDatabaseName(targetDbId),
      localPath,
      ...(input.forkDbIds && input.localAppId
        ? { schemaOwnerAppId: input.localAppId }
        : {}),
      updatedAt: new Date().toISOString(),
      ...(input.forkDbIds ? { createdAt: new Date().toISOString() } : {}),
    };
    if (targetDbId !== dbId) {
      delete merged.databases[dbId];
    }
    registryDbIds.add(targetDbId);
  }

  await writeDatabasesRegistry(input.targetRegistryPath, merged);
  return { registryDbIds, dbIdRemap };
}

export type SyncAppLinkedResourcesScope = "full" | "jobs_and_code";

export interface SyncAppLinkedResourcesInput {
  appId: string;
  sourcePaprHome: string;
  targetPaprHome: string;
  /** When source app id differs (cloud install remaps app id). */
  sourceAppId?: string;
  /** Fork install: mint new dbIds and copy schema only (no publisher rows). */
  installDbPolicy?: InstallDbPolicy;
  /**
   * Track sync with shared publisher DB: update jobs + paths only — never
   * re-copy registry SQLite from git.
   */
  syncScope?: SyncAppLinkedResourcesScope;
}

export interface SyncAppLinkedResourcesResult {
  copiedJobIds: string[];
  skippedJobIds: string[];
  copiedRegistryDbSlugs: string[];
  registryDbIds: string[];
}

export interface FinalizeCopiedAppResourcesInput {
  targetPaprHome: string;
  appId: string;
  copiedJobIds: readonly string[];
  registryDbIds: readonly string[];
}

/**
 * Repair hardcoded paths, reset Turso sync cursors, and drop stale cloud prefs
 * in the target workspace after a cross-namespace copy.
 */
export async function finalizeCopiedAppResources(
  input: FinalizeCopiedAppResourcesInput,
): Promise<void> {
  const { clearTursoPushState } = await import("./tursoSyncState.js");
  const { removeAppPublishPrefs } = await import("./cloudPublishPrefs.js");
  const { runPostMigrationPathRepair } = await import(
    "./postMigrationPathRepair.js"
  );

  for (const jobId of input.copiedJobIds) {
    clearTursoPushState(jobId, input.targetPaprHome);
  }
  for (const dbId of input.registryDbIds) {
    clearTursoPushState(dbId, input.targetPaprHome);
  }

  removeAppPublishPrefs(input.appId, input.targetPaprHome);

  const { preparePortableReplicaDatabases } = await import(
    "./tursoReplica/portableReplicaBootstrap.js"
  );
  await preparePortableReplicaDatabases({
    paprHome: input.targetPaprHome,
    registryDbIds: input.registryDbIds,
    copiedJobIds: input.copiedJobIds,
    reason: "cross_namespace_copy",
  });

  await runPostMigrationPathRepair({
    dryRun: false,
    includeApps: true,
    delayMs: 0,
    paprBase: input.targetPaprHome,
    scopePaprHome: input.targetPaprHome,
    skipDataSources: true,
  });
}

async function resolveSourceJobDirectory(
  sourcePaprHome: string,
  sourceAppId: string | undefined,
  jobId: string,
): Promise<string | null> {
  const canonical = path.join(sourcePaprHome, "Jobs", jobId);
  if (await pathExists(canonical)) {
    return canonical;
  }
  if (sourceAppId) {
    const bundled = path.join(sourcePaprHome, "apps", sourceAppId, "jobs", jobId);
    if (await pathExists(bundled)) {
      return bundled;
    }
  }
  return null;
}

async function readJobRecordFromDir(
  jobDir: string,
): Promise<JobRecord | undefined> {
  try {
    const raw = await fs.readFile(path.join(jobDir, "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return undefined;
  }
}

/** Copy linked job folders and jobs.json entries into the target workspace. */
export async function syncAppJobsToTarget(
  input: SyncAppLinkedResourcesInput,
): Promise<Pick<SyncAppLinkedResourcesResult, "copiedJobIds" | "skippedJobIds">> {
  const preserveLocalDatabase = input.syncScope === "jobs_and_code";

  if (
    path.normalize(input.sourcePaprHome) === path.normalize(input.targetPaprHome)
  ) {
    return { copiedJobIds: [], skippedJobIds: [] };
  }

  const targetAppDir = path.join(input.targetPaprHome, "apps", input.appId);
  if (!(await pathExists(targetAppDir))) {
    return { copiedJobIds: [], skippedJobIds: [] };
  }

  const targetJobsDir = path.join(input.targetPaprHome, "Jobs");
  const sourceJobsIndexPath = path.join(input.sourcePaprHome, "data", "jobs.json");
  const targetJobsIndexPath = path.join(input.targetPaprHome, "data", "jobs.json");

  await fs.mkdir(targetJobsDir, { recursive: true });

  const dependentJobIds = resolveAppDependentJobIds(
    input.sourcePaprHome,
    input.appId,
    input.sourceAppId ? { sourceAppId: input.sourceAppId } : undefined,
  );
  const copiedJobIdSet = new Set(dependentJobIds);
  const sourceJobs = await readJobsIndex(sourceJobsIndexPath);
  const sourceJobById = new Map(sourceJobs.map((job) => [job.id, job]));
  const targetJobs = await readJobsIndex(targetJobsIndexPath);
  const targetJobById = new Map(targetJobs.map((job) => [job.id, job]));

  const copiedJobIds: string[] = [];
  const skippedJobIds: string[] = [];

  for (const jobId of dependentJobIds) {
    const sourceJobDir = await resolveSourceJobDirectory(
      input.sourcePaprHome,
      input.sourceAppId,
      jobId,
    );
    const targetJobDir = path.join(targetJobsDir, jobId);
    let sourceJob = sourceJobById.get(jobId);
    if (!sourceJob && sourceJobDir) {
      sourceJob = await readJobRecordFromDir(sourceJobDir);
    }

    if (!sourceJobDir) {
      continue;
    }

    if (await pathExists(targetJobDir)) {
      const existing = targetJobById.get(jobId);
      const sourceUpdatedMs = sourceJob?.updatedAt
        ? new Date(sourceJob.updatedAt).getTime()
        : 0;
      const targetUpdatedMs = existing?.updatedAt
        ? new Date(existing.updatedAt).getTime()
        : 0;

      if (sourceJob && sourceUpdatedMs > targetUpdatedMs) {
        await replaceJobDirectoryPreservingDatabase({
          sourceJobDir,
          targetJobDir,
          preserveLocalDatabase,
        });
        copiedJobIds.push(jobId);
        targetJobById.set(
          jobId,
          prepareCopiedJobRecord(sourceJob, input.appId, copiedJobIdSet),
        );
      } else {
        skippedJobIds.push(jobId);
        if (sourceJob) {
          const mergedAppIds = mergeJobAppIds(existing?.appIds, [input.appId]);
          targetJobById.set(jobId, {
            ...(existing ?? sourceJob),
            appIds: mergedAppIds,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      continue;
    }

    await copyJobDirectory({
      sourceJobDir,
      targetJobDir,
      preserveLocalDatabase,
    });
    copiedJobIds.push(jobId);

    if (sourceJob) {
      targetJobById.set(
        jobId,
        prepareCopiedJobRecord(sourceJob, input.appId, copiedJobIdSet),
      );
    }
  }

  await writeJobsIndex(targetJobsIndexPath, [...targetJobById.values()]);

  return { copiedJobIds, skippedJobIds };
}

/** Merge registry metadata and copy SQLite files into the target workspace. */
export async function syncAppDatabaseResourcesToTarget(
  input: SyncAppLinkedResourcesInput & {
    copiedJobIds: readonly string[];
  },
): Promise<
  Pick<SyncAppLinkedResourcesResult, "copiedRegistryDbSlugs" | "registryDbIds">
> {
  const targetAppDir = path.join(input.targetPaprHome, "apps", input.appId);
  const targetDatabasesPath = path.join(
    input.targetPaprHome,
    "data",
    "databases.json",
  );
  const sourceJobsIndexPath = path.join(input.sourcePaprHome, "data", "jobs.json");
  const targetJobsIndexPath = path.join(input.targetPaprHome, "data", "jobs.json");
  const sourceJobs = await readJobsIndex(sourceJobsIndexPath);
  const targetJobs = await readJobsIndex(targetJobsIndexPath);
  const copiedJobIdSet = new Set(input.copiedJobIds);
  const dependentJobIds = resolveAppDependentJobIds(
    input.sourcePaprHome,
    input.appId,
    input.sourceAppId ? { sourceAppId: input.sourceAppId } : undefined,
  );
  const jobsForRegistry = dependentJobIds
    .map((jobId) => targetJobs.find((job) => job.id === jobId))
    .filter((job): job is JobRecord => job !== undefined);
  const dbIdsFromJobs = collectRegistryDbIds(
    jobsForRegistry.length > 0 ? jobsForRegistry : sourceJobs,
    copiedJobIdSet,
  );

  const sourceRegistryPath = path.join(
    input.sourcePaprHome,
    "data",
    "databases.json",
  );
  const sourceAppDir = input.sourceAppId
    ? path.join(input.sourcePaprHome, "apps", input.sourceAppId)
    : undefined;
  const forkDbIds = input.installDbPolicy === "fork_empty";
  const schemaOnly =
    input.installDbPolicy === "fork_empty" ||
    input.installDbPolicy === "shared_primary";
  const { registryDbIds, dbIdRemap } = await mergeDatabaseRegistryForCopy({
    sourceRegistryPath,
    targetRegistryPath: targetDatabasesPath,
    targetPaprHome: input.targetPaprHome,
    copiedJobIds: copiedJobIdSet,
    dbIdsFromJobs,
    appDir: targetAppDir,
    sourceAppDir,
    forkDbIds,
    localAppId: forkDbIds ? input.appId : undefined,
  });
  await applyDbIdRemapToAppFiles(targetAppDir, dbIdRemap);
  await rewriteDataSourcesForTarget(targetAppDir, input.targetPaprHome);

  const copiedRegistryDbSlugs = await copyRegistryDatabaseFiles({
    sourcePaprHome: input.sourcePaprHome,
    targetPaprHome: input.targetPaprHome,
    sourceRegistryPath,
    targetRegistryPath: targetDatabasesPath,
    dbIds: registryDbIds,
    copiedJobIds: copiedJobIdSet,
    schemaOnly,
  });

  await hydrateDataSourcesFromRegistry(
    targetAppDir,
    targetDatabasesPath,
    input.targetPaprHome,
  );

  const { hydrateAppFolderSchemaMigrationsToRegistry } = await import(
    "./syncV3/syncPulledSchemaOwnerMigrations.js"
  );
  const appsRoot = path.join(input.targetPaprHome, "apps");
  const hydratedMigrations = await hydrateAppFolderSchemaMigrationsToRegistry({
    appId: input.appId,
    paprRoot: input.targetPaprHome,
    appsRoot,
  });
  if (hydratedMigrations.copied.length > 0) {
    console.log(
      `[CopyApp] Mirrored ${hydratedMigrations.copied.length} migration(s) from app folder into registry for ${input.appId}`,
    );
  }

  return {
    copiedRegistryDbSlugs,
    registryDbIds: [...registryDbIds],
  };
}

/** Copy linked jobs, database registry entries, and rewrite data-sources paths into target. */
export async function syncAppLinkedResourcesToTarget(
  input: SyncAppLinkedResourcesInput,
): Promise<SyncAppLinkedResourcesResult> {
  if (
    path.normalize(input.sourcePaprHome) === path.normalize(input.targetPaprHome)
  ) {
    return {
      copiedJobIds: [],
      skippedJobIds: [],
      copiedRegistryDbSlugs: [],
      registryDbIds: [],
    };
  }

  const targetAppDir = path.join(input.targetPaprHome, "apps", input.appId);
  if (!(await pathExists(targetAppDir))) {
    return {
      copiedJobIds: [],
      skippedJobIds: [],
      copiedRegistryDbSlugs: [],
      registryDbIds: [],
    };
  }

  const jobsOnly = input.syncScope === "jobs_and_code";
  const { copiedJobIds, skippedJobIds } = await syncAppJobsToTarget(input);

  if (jobsOnly) {
    await rewriteDataSourcesForTarget(targetAppDir, input.targetPaprHome);
    return {
      copiedJobIds,
      skippedJobIds,
      copiedRegistryDbSlugs: [],
      registryDbIds: [],
    };
  }

  const database = await syncAppDatabaseResourcesToTarget({
    ...input,
    copiedJobIds,
  });

  return {
    copiedJobIds,
    skippedJobIds,
    copiedRegistryDbSlugs: database.copiedRegistryDbSlugs,
    registryDbIds: database.registryDbIds,
  };
}

export async function copyAppToNamespace(
  input: CopyAppToNamespaceInput,
): Promise<CopyAppToNamespaceResult> {
  const pointer = readActiveWorkspacePointer();
  if (!pointer) {
    throw new CopyAppError("no_workspace", "No active workspace");
  }

  if (
    pointer.organizationId === input.targetOrganizationId &&
    pointer.namespaceId === input.targetNamespaceId
  ) {
    throw new CopyAppError("same_namespace", "App is already in this namespace");
  }

  const sourcePaprHome = input.sourcePaprHome;
  const sourceAppsDir = path.join(sourcePaprHome, "apps");
  const sourceIndexPath = path.join(sourcePaprHome, "data", "apps.json");
  const sourceAppDir = path.join(sourceAppsDir, input.appId);

  try {
    await fs.access(sourceAppDir);
  } catch {
    throw new CopyAppError("app_not_found", "App folder not found");
  }

  const sourceApps = await readAppsIndex(sourceIndexPath);
  const app = sourceApps.find((entry) => entry.id === input.appId);
  if (!app) {
    throw new CopyAppError("app_not_found", "App not found in registry");
  }

  const targetPaprHome = resolveOrgNamespaceWorkspacePath(
    input.targetOrganizationId,
    input.targetNamespaceId,
  );
  const targetAppsDir = path.join(targetPaprHome, "apps");
  const targetJobsDir = path.join(targetPaprHome, "Jobs");
  const targetIndexPath = path.join(targetPaprHome, "data", "apps.json");
  const targetAppDir = path.join(targetAppsDir, input.appId);

  await fs.mkdir(targetAppsDir, { recursive: true });
  await fs.mkdir(targetJobsDir, { recursive: true });
  await fs.mkdir(path.dirname(targetIndexPath), { recursive: true });

  if (await pathExists(targetAppDir)) {
    throw new CopyAppError(
      "target_conflict",
      "This app already exists in the target namespace",
    );
  }

  const targetApps = await readAppsIndex(targetIndexPath);
  if (targetApps.some((entry) => entry.id === input.appId)) {
    throw new CopyAppError(
      "target_conflict",
      "This app is already registered in the target namespace",
    );
  }

  await fs.cp(sourceAppDir, targetAppDir, { recursive: true });

  const { copiedJobIds, skippedJobIds, copiedRegistryDbSlugs, registryDbIds } =
    await syncAppLinkedResourcesToTarget({
      appId: input.appId,
      sourcePaprHome,
      targetPaprHome,
    });

  await finalizeCopiedAppResources({
    targetPaprHome,
    appId: input.appId,
    copiedJobIds,
    registryDbIds,
  });

  const uniqueTitle = ensureUniqueAppTitle(
    app.title,
    targetApps.map((entry) => entry.title),
  );
  const titleRenamed = uniqueTitle !== app.title.trim();
  const ownerUserId = getPaprUserId()?.trim();
  const copiedApp: MiniApp = {
    ...app,
    title: uniqueTitle,
    updatedAt: new Date().toISOString(),
    cloudLineage: undefined,
    organizationId: input.targetOrganizationId,
    namespaceId: input.targetNamespaceId,
    ...(ownerUserId ? { ownerUserId } : {}),
  };

  targetApps.push(copiedApp);
  await writeAppsIndex(targetIndexPath, targetApps);
  // metadata.json is copied from the source folder and still points at the source
  // namespace. listApps() and pruneStrayWorkspaceAppCopies() prefer disk metadata,
  // so refresh it here or the copy vanishes when you switch workspaces.
  await writeCloudAppMetadataFile(targetPaprHome, input.appId);

  return {
    appId: input.appId,
    title: copiedApp.title,
    sourceNamespaceId: pointer.namespaceId,
    targetNamespaceId: input.targetNamespaceId,
    titleRenamed,
    copiedJobIds,
    skippedJobIds,
    copiedRegistryDbSlugs,
  };
}
