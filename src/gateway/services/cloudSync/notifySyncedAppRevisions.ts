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

  for (const appId of syncedAppIds) {
    try {
      const config = await publish.getPublishConfig(appId);
      if (!config.enabled) {
        continue;
      }
      const route = parsePublishedAppRoute(config.shareUrl);
      if (!route) {
        continue;
      }
      await notifyCloudAppRevisionUpdated(route);
    } catch (error) {
      console.warn(
        `[CloudSync] Skipped revision notify for ${appId}:`,
        (error as Error).message.slice(0, 80),
      );
    }
  }
}
