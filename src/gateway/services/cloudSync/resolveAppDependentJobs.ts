/**
 * Resolve job folders that belong to a mini-app for cloud sync.
 */

import * as fs from "fs";
import * as path from "path";
import { parseDataSourcesFile } from "../appDataSources.js";
import { jobBelongsToApp, STANDALONE_APP_ID } from "../jobs/appIds.js";

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

function readJobsIndex(paprDir: string): JobIndexEntry[] {
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "jobs.json"), "utf8");
    const parsed = JSON.parse(raw) as { jobs?: JobIndexEntry[] } | JobIndexEntry[];
    return Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
  } catch {
    return [];
  }
}

function readJobJson(paprDir: string, jobId: string): JobJsonEntry | null {
  const jobJsonPath = path.join(paprDir, "Jobs", jobId, "job.json");
  try {
    return JSON.parse(fs.readFileSync(jobJsonPath, "utf8")) as JobJsonEntry;
  } catch {
    return null;
  }
}

function readDataSourceJobIds(paprDir: string, appId: string): string[] {
  const dataSourcesPath = path.join(paprDir, "apps", appId, "data-sources.json");
  try {
    const raw = fs.readFileSync(dataSourcesPath, "utf8");
    const config = parseDataSourcesFile(raw);
    return config.sources
      .map((source) => source.jobId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
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
export function resolveAppDependentJobIds(paprDir: string, appId: string): string[] {
  const jobIds = new Set<string>(readDataSourceJobIds(paprDir, appId));

  for (const job of readJobsIndex(paprDir)) {
    if (!job.id) continue;
    if (jobBelongsToApp(job.appIds, appId)) {
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
