/**
 * Post-web-ready catalog + App Files sync for published apps.
 * Separated from writer push so flushAppNow can gate on webReady (SYNC_CONTRACT §12.1).
 */

import { isCloudCatalogLightSyncEnabled } from "../../../core/types/cloudPublishIntent.js";

export interface SyncPublishedAppCatalogResult {
  catalogSynced: boolean;
  catalogError?: string;
  /** False when the app has no cloud publish (nothing to mark complete). */
  published?: boolean;
}

export async function syncPublishedAppCatalogLayer(
  appId: string,
  options?: { afterWriterChange?: boolean },
): Promise<SyncPublishedAppCatalogResult> {
  try {
    const { getCloudAppPublishService } = await import(
      "../CloudAppPublishService.js"
    );
    const publish = getCloudAppPublishService();
    const status = await publish.getCloudPublishStatus(appId);
    if (!status.published) {
      return { catalogSynced: false, published: false };
    }

    if (isCloudCatalogLightSyncEnabled()) {
      await publish.syncLiveAppArtifacts(appId);
    }

    if (options?.afterWriterChange && isCloudCatalogLightSyncEnabled()) {
      await publish.updateCatalogMetadata(appId, { preserveCloudSharing: true });
      return { catalogSynced: true, published: true };
    }

    const syncedConfig = await publish.syncCatalogIfDrift(appId);
    return { catalogSynced: syncedConfig !== null, published: true };
  } catch (error) {
    const catalogError = (error as Error).message.slice(0, 200);
    console.warn(
      `[SyncPublishedAppCatalog] Catalog sync failed for ${appId}:`,
      catalogError,
    );
    return { catalogSynced: false, catalogError };
  }
}
