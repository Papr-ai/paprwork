/**
 * Keep Mongo jobs index, runtime, tombstones, and git in sync after a local delete.
 */

import type { JobConfigSlice } from "./jobRuntimeFields.js";
import {
  retryPendingMetadataUploads,
  uploadJobsIndexToCloud,
} from "../syncV3/MetadataRegistryClient.js";

export interface PushJobsIndexToCloudOptions {
  /** When true, await upload + drain metadata outbox (delete paths). */
  awaitCloudMetadata?: boolean;
}

export async function pushJobsIndexToCloudAfterLocalWrite(
  jobs: JobConfigSlice[],
  updatedAt: string,
  options?: PushJobsIndexToCloudOptions,
): Promise<void> {
  if (!options?.awaitCloudMetadata) {
    void uploadJobsIndexToCloud(jobs, updatedAt).catch((err: Error) => {
      console.warn(
        "[JobDeletionCatalog] jobs index cloud upload failed:",
        err.message.slice(0, 120),
      );
    });
    return;
  }

  await uploadJobsIndexToCloud(jobs, updatedAt);
  await retryPendingMetadataUploads();
}
