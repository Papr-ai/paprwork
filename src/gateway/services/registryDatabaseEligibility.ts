/**
 * Which local paths may appear in databases.json or Turso Plan A app links.
 * Job scratch (Jobs/{id}/data/data.db) is local job infra only.
 */

import path from "path";
import { isJobScratchDatabasePath } from "./jobs/jobScratchDatabasePath.js";
import type { AppDataSource } from "./appDataSources.js";

export const JOB_SCRATCH_NOT_REGISTRY_MESSAGE =
  "Job scratch (Jobs/{jobId}/data/data.db) cannot be a registry or Turso-linked app database. " +
  "Use create_database → attach_database({ dbId }) and create_job({ writeDbIds: [dbId] }). " +
  "To move app data out of a job folder, use link with promotion (jobId link) or promote_job_database tooling.";

export function isEligibleRegistryLocalPath(dbPath: string): boolean {
  const normalized = path.normalize(dbPath.trim());
  if (!normalized) {
    return false;
  }
  return !isJobScratchDatabasePath(normalized);
}

export function assertEligibleRegistryLocalPath(dbPath: string): void {
  if (!isEligibleRegistryLocalPath(dbPath)) {
    throw new Error(`${JOB_SCRATCH_NOT_REGISTRY_MESSAGE} Path: ${dbPath}`);
  }
}

/** Reject Turso/registry links that point at job scratch (forward writes only). */
export function assertDataSourcesEligibleForRegistry(
  sources: readonly AppDataSource[],
): void {
  for (const source of sources) {
    const dbPath = source.dbPath?.trim();
    if (dbPath && !isEligibleRegistryLocalPath(dbPath)) {
      throw new Error(
        `${JOB_SCRATCH_NOT_REGISTRY_MESSAGE} Source alias "${source.alias}".`,
      );
    }
  }
}
