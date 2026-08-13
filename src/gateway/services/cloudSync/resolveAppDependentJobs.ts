/**
 * Resolve job folders that belong to a mini-app for cloud sync.
 */

import * as path from "path";
import { parseDataSourcesFile } from "../appDataSources.js";
import { jobBelongsToApp, STANDALONE_APP_ID } from "../jobs/appIds.js";
import { readDerivedFromFile } from "./jsonFileCache.js";

interface JobIndexEntry {
  id: string;
  appIds?: string[];
  dependsOn?: Array<{ jobId: string }>;
  runtimeCalls?: string[];
}

interface JobJsonEntry {
  id?: string;
  dependsOn?: Array<{ jobId: string }>;
  runtimeCalls?: string[];
}

const NO_JOB_IDS: readonly string[] = Object.freeze([]);
const NO_JOBS_INDEX: readonly JobIndexEntry[] = Object.freeze([]);

function readJobsIndex(paprDir: string): readonly JobIndexEntry[] {
  return readDerivedFromFile(
    path.join(paprDir, "data", "jobs.json"),
    "jobsIndex",
    (raw) => {
      const parsed = JSON.parse(raw) as { jobs?: JobIndexEntry[] } | JobIndexEntry[];
      return Object.freeze(Array.isArray(parsed) ? parsed : parsed.jobs ?? []);
    },
    NO_JOBS_INDEX,
  );
}

function readJobJson(paprDir: string, jobId: string): JobJsonEntry | null {
  return readDerivedFromFile<JobJsonEntry | null>(
    path.join(paprDir, "Jobs", jobId, "job.json"),
    "jobJson",
    (raw) => JSON.parse(raw) as JobJsonEntry,
    null,
  );
}

function readAgentChatJobId(paprDir: string, appId: string): string | null {
  return readDerivedFromFile<string | null>(
    path.join(paprDir, "apps", appId, "metadata.json"),
    "agentChatJobId",
    (raw) => {
      const parsed = JSON.parse(raw) as { agentChatJobId?: string };
      const jobId = parsed.agentChatJobId?.trim();
      return jobId && jobId.length > 0 ? jobId : null;
    },
    null,
  );
}

function readDataSourceJobIds(paprDir: string, appId: string): readonly string[] {
  return readDerivedFromFile<readonly string[]>(
    path.join(paprDir, "apps", appId, "data-sources.json"),
    "dataSourceJobIds",
    (raw) =>
      Object.freeze(
        parseDataSourcesFile(raw)
          .sources.map((source) => source.jobId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    NO_JOB_IDS,
  );
}

/** Registry dbIds linked in app data-sources (require databases.json on web). */
export function readDataSourceRegistryDbIds(paprDir: string, appId: string): string[] {
  const cached = readDerivedFromFile<readonly string[]>(
    path.join(paprDir, "apps", appId, "data-sources.json"),
    "dataSourceRegistryDbIds",
    (raw) => {
      const dbIds = new Set<string>();
      for (const source of parseDataSourcesFile(raw).sources) {
        if (source.dbId?.trim()) {
          dbIds.add(source.dbId.trim());
        }
      }
      return Object.freeze([...dbIds].sort());
    },
    NO_JOB_IDS,
  );
  return [...cached];
}

/** Git-relative paths to upload so apps.papr.ai can serve this app. */
export function resolveAppCloudSyncRelativePaths(
  paprDir: string,
  appId: string,
): string[] {
  const dependentJobIds = resolveAppDependentJobIds(paprDir, appId);
  const paths = [
    path.join("apps", appId),
    ...dependentJobIds.map(jobRelativePath),
  ];
  // jobs.json index must travel with job folders — memory runtime resolves jobId from it.
  if (dependentJobIds.length > 0) {
    paths.push(path.join("data", "jobs.json"));
  }
  if (readDataSourceRegistryDbIds(paprDir, appId).length > 0) {
    paths.push("data");
  }
  return paths;
}

function expandJobPipeline(paprDir: string, seedJobIds: readonly string[]): string[] {
  const visited = new Set<string>();
  const queue = [...seedJobIds];

  while (queue.length > 0) {
    const jobId = queue.pop()!;
    if (visited.has(jobId)) continue;
    visited.add(jobId);

    const jobJson = readJobJson(paprDir, jobId);
    if (!jobJson) continue;

    for (const dep of jobJson.dependsOn ?? []) {
      if (dep.jobId && !visited.has(dep.jobId)) {
        queue.push(dep.jobId);
      }
    }
    for (const calleeId of jobJson.runtimeCalls ?? []) {
      if (calleeId && !visited.has(calleeId)) {
        queue.push(calleeId);
      }
    }
  }

  return [...visited];
}

/** Job IDs linked to an app via data-sources, appIds, and dependency/runtime chains. */
export function resolveAppDependentJobIds(
  paprDir: string,
  appId: string,
  options?: { sourceAppId?: string },
): string[] {
  const resolveAppId = options?.sourceAppId ?? appId;
  const jobIds = new Set<string>(readDataSourceJobIds(paprDir, resolveAppId));

  const agentChatJobId = readAgentChatJobId(paprDir, resolveAppId);
  if (agentChatJobId) {
    jobIds.add(agentChatJobId);
  }

  for (const job of readJobsIndex(paprDir)) {
    if (!job.id) continue;
    if (jobBelongsToApp(job.appIds, resolveAppId)) {
      jobIds.add(job.id);
    }
  }

  const expanded = expandJobPipeline(paprDir, [...jobIds]);
  return expanded.filter((jobId) => jobId !== STANDALONE_APP_ID).sort();
}

/** Canonical git-relative path for a job folder. */
export function jobRelativePath(jobId: string): string {
  return path.join("Jobs", jobId);
}
