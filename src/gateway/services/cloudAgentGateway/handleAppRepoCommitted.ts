/**
 * Proactive cache bust when an app repo is published — complements HEAD checks in cloneUserRepo.
 */

import { invalidateAppRepoCloneCacheForEvent } from "./appRepoCloneCache.js";
import type { AppRepoCommittedEvent } from "../syncV3/appRepoCommittedFanout.js";
import { getCloudAgentSessionCache } from "./cloudAgentSessionCache.js";

export async function handleCloudAgentAppRepoCommitted(
  event: AppRepoCommittedEvent,
): Promise<{ diskCacheInvalidated: boolean; warmSessionsEnded: number }> {
  const diskCacheInvalidated = await invalidateAppRepoCloneCacheForEvent(event);
  const warmSessionsEnded = await getCloudAgentSessionCache().invalidateSessionsForApp(
    event.appId,
  );
  if (diskCacheInvalidated || warmSessionsEnded > 0) {
    console.log(
      `[CloudAgentClone] Publish invalidation appId=${event.appId} ` +
        `commit=${event.commitSha.slice(0, 8)} disk=${diskCacheInvalidated} sessions=${warmSessionsEnded}`,
    );
  }
  return { diskCacheInvalidated, warmSessionsEnded };
}
