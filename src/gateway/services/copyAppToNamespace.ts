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
import type { DatabasesRegistryFile } from "./DatabaseRegistryService.js";
import { getPaprUserId } from "../utils/paprUserId.js";

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
    return source;
  });

  const next: AppDataSourcesFile = { sources };
  await fs.writeFile(configPath, serializeDataSourcesFile(next), "utf8");
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

async function mergeDatabaseRegistryForCopy(input: {
  sourceRegistryPath: string;
  targetRegistryPath: string;
  targetPaprHome: string;
  copiedJobIds: ReadonlySet<string>;
  dbIdsFromJobs: Set<string>;
  appDir: string;
}): Promise<void> {
  const sourceRegistry = await readDatabasesRegistry(input.sourceRegistryPath);
  const targetRegistry = await readDatabasesRegistry(input.targetRegistryPath);
  const dbIds = new Set(input.dbIdsFromJobs);

  try {
    const raw = await fs.readFile(
      path.join(input.appDir, "data-sources.json"),
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

  const merged: DatabasesRegistryFile = {
    version: 1,
    databases: { ...targetRegistry.databases },
  };

  for (const dbId of dbIds) {
    if (merged.databases[dbId]) {
      continue;
    }
    const record = sourceRegistry.databases[dbId];
    if (!record) {
      continue;
    }
    const ownerJobId = record.ownerJobId;
    const localPath =
      ownerJobId && input.copiedJobIds.has(ownerJobId)
        ? jobDatabasePath(input.targetPaprHome, ownerJobId)
        : record.localPath;
    merged.databases[dbId] = {
      ...record,
      localPath,
      updatedAt: new Date().toISOString(),
    };
  }

  await writeDatabasesRegistry(input.targetRegistryPath, merged);
}

export interface SyncAppLinkedResourcesInput {
  appId: string;
  sourcePaprHome: string;
  targetPaprHome: string;
}

export interface SyncAppLinkedResourcesResult {
  copiedJobIds: string[];
  skippedJobIds: string[];
}

/** Copy linked jobs, database registry entries, and rewrite data-sources paths into target. */
export async function syncAppLinkedResourcesToTarget(
  input: SyncAppLinkedResourcesInput,
): Promise<SyncAppLinkedResourcesResult> {
  if (
    path.normalize(input.sourcePaprHome) === path.normalize(input.targetPaprHome)
  ) {
    return { copiedJobIds: [], skippedJobIds: [] };
  }

  const targetAppDir = path.join(input.targetPaprHome, "apps", input.appId);
  if (!(await pathExists(targetAppDir))) {
    return { copiedJobIds: [], skippedJobIds: [] };
  }

  const sourceJobsDir = path.join(input.sourcePaprHome, "Jobs");
  const targetJobsDir = path.join(input.targetPaprHome, "Jobs");
  const sourceJobsIndexPath = path.join(input.sourcePaprHome, "data", "jobs.json");
  const targetJobsIndexPath = path.join(input.targetPaprHome, "data", "jobs.json");
  const targetDatabasesPath = path.join(
    input.targetPaprHome,
    "data",
    "databases.json",
  );

  await fs.mkdir(targetJobsDir, { recursive: true });

  const dependentJobIds = resolveAppDependentJobIds(
    input.sourcePaprHome,
    input.appId,
  );
  const copiedJobIdSet = new Set(dependentJobIds);
  const sourceJobs = await readJobsIndex(sourceJobsIndexPath);
  const sourceJobById = new Map(sourceJobs.map((job) => [job.id, job]));
  const targetJobs = await readJobsIndex(targetJobsIndexPath);
  const targetJobById = new Map(targetJobs.map((job) => [job.id, job]));

  const copiedJobIds: string[] = [];
  const skippedJobIds: string[] = [];

  for (const jobId of dependentJobIds) {
    const sourceJobDir = path.join(sourceJobsDir, jobId);
    const targetJobDir = path.join(targetJobsDir, jobId);
    const sourceJob = sourceJobById.get(jobId);

    if (!(await pathExists(sourceJobDir))) {
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
        await fs.rm(targetJobDir, { recursive: true, force: true });
        await fs.cp(sourceJobDir, targetJobDir, { recursive: true });
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

    await fs.cp(sourceJobDir, targetJobDir, { recursive: true });
    copiedJobIds.push(jobId);

    if (sourceJob) {
      targetJobById.set(
        jobId,
        prepareCopiedJobRecord(sourceJob, input.appId, copiedJobIdSet),
      );
    }
  }

  await writeJobsIndex(targetJobsIndexPath, [...targetJobById.values()]);
  await rewriteDataSourcesForTarget(targetAppDir, input.targetPaprHome);

  const jobsForRegistry = dependentJobIds
    .map((jobId) => targetJobById.get(jobId))
    .filter((job): job is JobRecord => job !== undefined);
  const dbIdsFromJobs = collectRegistryDbIds(jobsForRegistry, copiedJobIdSet);
  await mergeDatabaseRegistryForCopy({
    sourceRegistryPath: path.join(input.sourcePaprHome, "data", "databases.json"),
    targetRegistryPath: targetDatabasesPath,
    targetPaprHome: input.targetPaprHome,
    copiedJobIds: copiedJobIdSet,
    dbIdsFromJobs,
    appDir: targetAppDir,
  });

  return { copiedJobIds, skippedJobIds };
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

  const { copiedJobIds, skippedJobIds } = await syncAppLinkedResourcesToTarget({
    appId: input.appId,
    sourcePaprHome,
    targetPaprHome,
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

  return {
    appId: input.appId,
    title: copiedApp.title,
    sourceNamespaceId: pointer.namespaceId,
    targetNamespaceId: input.targetNamespaceId,
    titleRenamed,
    copiedJobIds,
    skippedJobIds,
  };
}
