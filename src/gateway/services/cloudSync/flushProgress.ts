/**
 * Live upload phase labels for /api/sync/items during ordered flush.
 */

import type { SyncCoordinatorLayer } from "./coordinatorTypes.js";

export interface FlushProgressUpdate {
  layer: SyncCoordinatorLayer;
  label: string;
  detail?: string;
}

export async function reportFlushProgress(
  appId: string,
  progress: FlushProgressUpdate,
): Promise<void> {
  const { getSyncCoordinator } = await import("./SyncCoordinator.js");
  getSyncCoordinator()?.setFlushProgress(appId, progress);
}
