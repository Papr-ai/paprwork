/**
 * After git sync, notify apps.papr.ai for each published app that changed.
 */

import {
  notifyCloudAppRevisionUpdated,
  parsePublishedAppRoute,
} from "./notifyCloudAppRevision.js";

export async function notifySyncedAppRevisions(
  syncedAppIds: readonly string[],
): Promise<void> {
  if (syncedAppIds.length === 0) {
    return;
  }
  if (!process.env.PAPR_CLOUD_APP_HOST_KEY?.trim()) {
    return;
  }

  const { getCloudAppPublishService } = await import("../CloudAppPublishService.js");
  const publish = getCloudAppPublishService();
  const { readAppRepoCommitCursors } = await import("../syncV3/appRepoCommittedFanout.js");
  const cursors = await readAppRepoCommitCursors().catch(() => ({}) as Record<string, { lastCommitSha?: string }>);

  for (const appId of syncedAppIds) {
    try {
      const status = await publish.getCloudPublishStatus(appId);
      if (!status.published || !status.shareUrl) {
        continue;
      }
      const route = parsePublishedAppRoute(status.shareUrl);
      if (!route) {
        continue;
      }
      // Pass the just-committed SHA so the host switches to it immediately.
      await notifyCloudAppRevisionUpdated({ ...route, commitSha: cursors[appId]?.lastCommitSha });
    } catch (error) {
      console.warn(
        `[CloudSync] Skipped revision notify for ${appId}:`,
        (error as Error).message.slice(0, 80),
      );
    }
  }
}
