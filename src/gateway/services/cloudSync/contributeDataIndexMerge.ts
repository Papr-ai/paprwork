/**
 * Merge contributor jobs.json / databases.json slices into owner repo on contribute-back.
 *
 * Matches cloud sync intent in resolveAppCloudSyncRelativePaths — job folders travel with
 * index updates, without overwriting unrelated owner workspace entries.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { DatabasesRegistryFile, DatabaseRecord } from "../DatabaseRegistryService.js";
import type { JobRecord } from "../jobs/types.js";
import {
  readDataSourceRegistryDbIds,
  resolveAppDependentJobIds,
} from "./resolveAppDependentJobs.js";

export interface ContributeDataIndexMergeInput {
  repoDir: string;
  contributorPaprDir: string;
  forkAppId: string;
  targetAppId: string;
}

export interface ContributeDataIndexMergeResult {
  /** Git-relative paths written under repoDir (e.g. data/jobs.json). */
  paths: string[];
}

function readJobsArray(raw: string): JobRecord[] {
  const parsed = JSON.parse(raw) as JobRecord[] | { jobs?: JobRecord[] };
  return Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
}

async function readJobsFile(filePath: string): Promise<JobRecord[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return readJobsArray(raw);
  } catch {
    return [];
  }
}

async function readRegistryFile(filePath: string): Promise<DatabasesRegistryFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return { version: 1, databases: {} };
  }
}

function remapJobForContribute(
  job: JobRecord,
  forkAppId: string,
  targetAppId: string,
): JobRecord {
  const remapped: JobRecord = {
    ...job,
    appIds: (job.appIds ?? []).map((id) => (id === forkAppId ? targetAppId : id)),
  };
  if (remapped.command?.includes(forkAppId)) {
    remapped.command = remapped.command.split(forkAppId).join(targetAppId);
  }
  return remapped;
}

async function readContributorJobs(contributorPaprDir: string): Promise<JobRecord[]> {
  return readJobsFile(path.join(contributorPaprDir, "data", "jobs.json"));
}

async function readContributorRegistry(
  contributorPaprDir: string,
): Promise<DatabasesRegistryFile> {
  return readRegistryFile(path.join(contributorPaprDir, "data", "databases.json"));
}

/** Registry dbIds the contribute PR must include (data-sources + job writeDbIds + ownerJobId). */
export async function resolveContributeRegistryDbIds(
  contributorPaprDir: string,
  forkAppId: string,
  dependentJobIds: readonly string[],
): Promise<string[]> {
  const dbIds = new Set(readDataSourceRegistryDbIds(contributorPaprDir, forkAppId));
  const contributorJobs = await readContributorJobs(contributorPaprDir);

  for (const job of contributorJobs) {
    if (!dependentJobIds.includes(job.id)) continue;
    for (const dbId of job.writeDbIds ?? []) {
      if (dbId.trim()) dbIds.add(dbId.trim());
    }
  }

  const registry = await readContributorRegistry(contributorPaprDir);
  for (const [dbId, record] of Object.entries(registry.databases ?? {})) {
    if (record.ownerJobId && dependentJobIds.includes(record.ownerJobId)) {
      dbIds.add(dbId);
    }
  }

  return [...dbIds].sort();
}

export function mergeJobsJsonForContribute(
  ownerJobs: JobRecord[],
  contributorJobs: JobRecord[],
  dependentJobIds: readonly string[],
  forkAppId: string,
  targetAppId: string,
): JobRecord[] {
  const dependent = new Set(dependentJobIds);
  const slice = contributorJobs
    .filter((job) => dependent.has(job.id))
    .map((job) => remapJobForContribute(job, forkAppId, targetAppId));

  if (slice.length === 0) {
    return ownerJobs;
  }

  const byId = new Map(ownerJobs.map((job) => [job.id, job]));
  for (const job of slice) {
    byId.set(job.id, job);
  }

  return [...byId.values()].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function portableDatabaseRecord(record: DatabaseRecord): DatabaseRecord {
  return {
    ...record,
    localPath: "",
  };
}

export function mergeDatabasesJsonForContribute(
  ownerRegistry: DatabasesRegistryFile,
  contributorRegistry: DatabasesRegistryFile,
  registryDbIds: readonly string[],
): DatabasesRegistryFile {
  if (registryDbIds.length === 0) {
    return ownerRegistry;
  }

  const databases = { ...ownerRegistry.databases };
  for (const dbId of registryDbIds) {
    const record = contributorRegistry.databases[dbId];
    if (!record || record.status === "tombstone") continue;
    databases[dbId] = portableDatabaseRecord(record);
  }

  return { version: 1, databases };
}

export async function mergeContributeDataIndexesIntoRepo(
  input: ContributeDataIndexMergeInput,
): Promise<ContributeDataIndexMergeResult> {
  const dependentJobIds = resolveAppDependentJobIds(
    input.contributorPaprDir,
    input.forkAppId,
  );
  const registryDbIds = await resolveContributeRegistryDbIds(
    input.contributorPaprDir,
    input.forkAppId,
    dependentJobIds,
  );

  const written: string[] = [];
  const dataDir = path.join(input.repoDir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  if (dependentJobIds.length > 0) {
    const ownerJobs = await readJobsFile(path.join(dataDir, "jobs.json"));
    const contributorJobs = await readJobsFile(
      path.join(input.contributorPaprDir, "data", "jobs.json"),
    );
    const merged = mergeJobsJsonForContribute(
      ownerJobs,
      contributorJobs,
      dependentJobIds,
      input.forkAppId,
      input.targetAppId,
    );
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    const jobsPath = path.join(dataDir, "jobs.json");
    let previous = "";
    try {
      previous = await fs.readFile(jobsPath, "utf8");
    } catch {
      /* new file */
    }
    if (previous !== next) {
      await fs.writeFile(jobsPath, next, "utf8");
      written.push(path.join("data", "jobs.json").replace(/\\/g, "/"));
    }
  }

  if (registryDbIds.length > 0) {
    const ownerRegistry = await readRegistryFile(
      path.join(dataDir, "databases.json"),
    );
    const contributorRegistry = await readRegistryFile(
      path.join(input.contributorPaprDir, "data", "databases.json"),
    );
    const merged = mergeDatabasesJsonForContribute(
      ownerRegistry,
      contributorRegistry,
      registryDbIds,
    );
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    const databasesPath = path.join(dataDir, "databases.json");
    let previous = "";
    try {
      previous = await fs.readFile(databasesPath, "utf8");
    } catch {
      /* new file */
    }
    if (previous !== next) {
      await fs.writeFile(databasesPath, next, "utf8");
      written.push(path.join("data", "databases.json").replace(/\\/g, "/"));
    }
  }

  return { paths: written };
}
