/**
 * Filesystem index of jobId → data.db path across Papr layouts.
 * Used by offline repair scripts without loading JobsService.
 */

import { existsSync, realpathSync, type Dirent } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";

const JOB_DB_REL = path.join("data", "data.db");

function pathsReferToSameLocation(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.normalize(a) === path.normalize(b);
  }
}

async function indexJobsInRoot(
  jobsRoot: string,
  index: Map<string, string>,
  options: { overwriteExisting?: boolean } = {},
): Promise<void> {
  const overwriteExisting = options.overwriteExisting ?? true;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(jobsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(jobsRoot, entry.name, JOB_DB_REL);
    if (!existsSync(dbPath)) continue;
    if (!overwriteExisting && index.has(entry.name)) continue;
    index.set(entry.name, dbPath);
  }
}

/**
 * Build a map of jobId → absolute data.db path by scanning Jobs/ trees.
 * Namespace-scoped paths overwrite flat legacy entries when both exist.
 */
export async function buildJobDatabasePathIndex(
  paprBase: string = getPaprBaseDir(),
): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  const upperJobsRoot = path.join(paprBase, "Jobs");
  const lowerJobsRoot = path.join(paprBase, "jobs");

  await indexJobsInRoot(upperJobsRoot, index);
  if (!pathsReferToSameLocation(upperJobsRoot, lowerJobsRoot)) {
    await indexJobsInRoot(lowerJobsRoot, index, { overwriteExisting: false });
  }

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return index;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      await indexJobsInRoot(
        path.join(namespacesDir, namespaceId, "Jobs"),
        index,
      );
    }
  }

  return index;
}

export function inferWorkspaceRootFromDataSourcesPath(
  dataSourcesPath: string,
  paprBase: string,
): string | null {
  const rel = path.relative(paprBase, dataSourcesPath);
  const segments = rel.split(path.sep);
  if (
    segments.length >= 5 &&
    segments[0] === "orgs" &&
    segments[2] === "namespaces" &&
    segments[4] === "apps"
  ) {
    return path.join(paprBase, "orgs", segments[1], "namespaces", segments[3]);
  }
  if (segments[0] === "apps") {
    return paprBase;
  }
  return null;
}

export function createJobPathResolverForDataSourcesFile(
  dataSourcesPath: string,
  paprBase: string,
  globalIndex: Map<string, string>,
): { getJobDatabasePath(jobId: string): string | null } {
  const workspaceRoot = inferWorkspaceRootFromDataSourcesPath(
    dataSourcesPath,
    paprBase,
  );

  return {
    getJobDatabasePath(jobId: string): string | null {
      if (workspaceRoot) {
        const localPath = path.join(
          workspaceRoot,
          "Jobs",
          jobId,
          "data",
          "data.db",
        );
        if (existsSync(localPath)) {
          return localPath;
        }
      }
      return globalIndex.get(jobId) ?? null;
    },
  };
}
