/**
 * Background catalog auto-publish (Sync V3).
 *
 * Namespace-monorepo era merged every autoPublish prefs app into each flush
 * post-hook. Per-app repos only need drift/republish for apps that actually
 * flushed; prefs-only recovery runs here on a throttled heartbeat tick.
 */

import { readGatewaySyncBusyState } from "./syncBusyState.js";

const CATALOG_AUTO_PUBLISH_INTERVAL_MS = 15 * 60_000;

let lastCatalogAutoPublishMs = 0;
let catalogScanInFlight = false;

export function resetBackgroundAutoPublishCatalogScanForTests(): void {
  lastCatalogAutoPublishMs = 0;
  catalogScanInFlight = false;
}

/** Throttled catalog scan — skips when upload queue is active. */
export async function maybeRunBackgroundAutoPublishCatalogScan(
  paprDir: string,
): Promise<void> {
  const now = Date.now();
  if (catalogScanInFlight) {
    return;
  }
  if (now - lastCatalogAutoPublishMs < CATALOG_AUTO_PUBLISH_INTERVAL_MS) {
    return;
  }

  const syncBusy = readGatewaySyncBusyState(paprDir);
  if (syncBusy && (syncBusy.queueDepth ?? 0) > 0) {
    return;
  }

  lastCatalogAutoPublishMs = now;
  catalogScanInFlight = true;

  try {
    const { getCloudSyncService } = await import("../CloudSyncService.js");
    const sync = getCloudSyncService();
    if (!sync) {
      return;
    }
    await sync.runBackgroundAutoPublishCatalogScan();
  } catch (err) {
    console.warn(
      "[CloudSync] Background catalog auto-publish skipped:",
      (err as Error).message.slice(0, 120),
    );
  } finally {
    catalogScanInFlight = false;
  }
}
