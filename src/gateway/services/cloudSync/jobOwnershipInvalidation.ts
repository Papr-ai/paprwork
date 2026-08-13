/**
 * Invalidate cached jobId→appIds ownership after workspace topology changes.
 *
 * Call when app/job links change (create/delete, data-sources, metadata agent chat).
 * Do NOT call on job status/runtime updates — those use saveJobs() frequently.
 */

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { invalidateJobOwnerIndex } from "../cloudUploadMode.js";

export function notifyJobOwnershipChanged(paprDir?: string): void {
  invalidateJobOwnerIndex(paprDir ?? getPaprRoot());
}

export function jobUpdateAffectsOwnership(
  updates: Partial<{ appIds?: string[]; dependsOn?: unknown }>,
): boolean {
  return updates.appIds !== undefined || updates.dependsOn !== undefined;
}
