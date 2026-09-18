/**
 * Notify renderer that /api/sync/items snapshots may be stale (any upload path).
 */

import { broadcast } from "../../websocket/index.js";

export function notifyCloudSyncItemsStale(appId?: string): void {
  broadcast({
    type: "cloud-sync:items-stale",
    data: appId ? { appId } : {},
  });
}
