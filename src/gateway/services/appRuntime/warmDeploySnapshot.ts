/**
 * Warm immutable GCS deploy snapshots after desktop sync.
 */

import type { AppRuntimeRouteAuth } from "./types.js";
import {
  fetchCachedRuntimeRepoFile,
  resolveAppCacheRevision,
} from "./cloudAppHostCache.js";
import {
  DEPLOY_SNAPSHOT_PATHS,
  gcsDeploySnapshotPut,
} from "./gcsDeploySnapshot.js";
import { isGcsSharedCacheEnabled } from "./gcsSharedCache.js";

/** After Sync now, prefetch deploy assets from GitHub into GCS. */
export async function warmDeploySnapshotForPublishedApp(
  auth: AppRuntimeRouteAuth,
): Promise<{ revision: string; warmed: number }> {
  if (!isGcsSharedCacheEnabled()) {
    return { revision: "0", warmed: 0 };
  }

  const revision = await resolveAppCacheRevision(auth, true);
  let warmed = 0;
  for (const relativePath of DEPLOY_SNAPSHOT_PATHS) {
    const file = await fetchCachedRuntimeRepoFile(auth, relativePath, {
      bypassFresh: true,
    });
    if (!file) {
      continue;
    }
    gcsDeploySnapshotPut(auth.namespaceId, auth.slug, revision, relativePath, file);
    warmed += 1;
  }
  return { revision, warmed };
}
