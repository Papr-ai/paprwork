/**
 * Remove cloud-side artifacts when a job is deleted locally.
 */

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { addJobTombstones, JOB_TOMBSTONES_FILENAME } from "./jobTombstones.js";
import { deleteJobRuntimePatch } from "./jobRuntimeCloudUpload.js";
import { deleteCloudJobCatalogEntry } from "./jobCloudSummary.js";

export interface DeleteJobCloudArtifactsResult {
  runtimeDeleted: boolean;
  catalogDeleted: boolean;
  tombstoned: boolean;
  workspacePushAttempted: boolean;
}

export interface DeleteJobCloudArtifactsOptions {
  /** Skip workspace git push (e.g. during JobsService startup reconcile). */
  skipWorkspacePush?: boolean;
}

async function enqueueDeletedJobSyncPaths(jobId: string): Promise<void> {
  try {
    const { getCloudSyncService } = await import("../CloudSyncService.js");
    const cloudSync = getCloudSyncService();
    if (!cloudSync) {
      return;
    }
    cloudSync.enqueueRelativePath("data/jobs.json");
    cloudSync.enqueueRelativePath(`Jobs/${jobId}`);
    cloudSync.enqueueRelativePath(`data/${JOB_TOMBSTONES_FILENAME}`);
  } catch {
    /* cloud sync not ready */
  }
}

export async function deleteJobCloudArtifacts(
  jobId: string,
  options?: DeleteJobCloudArtifactsOptions,
): Promise<DeleteJobCloudArtifactsResult> {
  const trimmed = jobId.trim();
  const result: DeleteJobCloudArtifactsResult = {
    runtimeDeleted: false,
    catalogDeleted: false,
    tombstoned: false,
    workspacePushAttempted: false,
  };
  if (!trimmed) {
    return result;
  }

  result.runtimeDeleted = await deleteJobRuntimePatch(trimmed);
  result.catalogDeleted = await deleteCloudJobCatalogEntry(trimmed);

  try {
    await addJobTombstones(getPaprRoot(), [trimmed]);
    result.tombstoned = true;
  } catch (err) {
    console.warn(
      `[JobCloudCleanup] Failed to tombstone ${trimmed}:`,
      (err as Error).message.slice(0, 120),
    );
  }

  await enqueueDeletedJobSyncPaths(trimmed);

  if (!options?.skipWorkspacePush) {
    try {
      const { getCloudSyncService } = await import("../CloudSyncService.js");
      const cloudSync = getCloudSyncService();
      if (cloudSync) {
        result.workspacePushAttempted = true;
        await cloudSync.pushNow();
      }
    } catch (err) {
      console.warn(
        `[JobCloudCleanup] Workspace push after delete failed for ${trimmed}:`,
        (err as Error).message.slice(0, 120),
      );
    }
  }

  return result;
}
