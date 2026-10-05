/**
 * Start publishes for apps whose databases are held by a breaking migration
 * (Phase 3 triggers: gateway startup, reconnect). End-of-turn and explicit sync
 * already flush the app; the held steps run inside that flush.
 */

import { listReplicaPublishHolds } from "./replicaPublishHold.js";

export type HeldPublishTrigger = "startup" | "reconnect";

/** App ids to publish for the current holds (dbId links + recorded owner). */
export async function appIdsForHeldDatabases(paprDir: string): Promise<string[]> {
  const holds = listReplicaPublishHolds();
  if (holds.length === 0) return [];
  const { listAppIdsLinkingSyncKey } = await import("../tursoLinkedSources.js");
  const ids = new Set<string>();
  for (const hold of holds) {
    if (hold.appId) ids.add(hold.appId);
    if (hold.dbId) {
      for (const id of listAppIdsLinkingSyncKey(hold.dbId, paprDir)) ids.add(id);
    }
  }
  return [...ids];
}

export async function scheduleHeldPublishes(trigger: HeldPublishTrigger): Promise<string[]> {
  try {
    const { isTursoReplicaOnline } = await import("../../utils/tursoReplicaEnabled.js");
    if (!isTursoReplicaOnline()) return [];
    const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
    const appIds = await appIdsForHeldDatabases(getPaprRoot());
    if (appIds.length === 0) return [];
    const { getSyncCoordinator } = await import("../cloudSync/SyncCoordinator.js");
    const coordinator = getSyncCoordinator();
    if (!coordinator) return [];
    for (const appId of appIds) {
      console.log(`[PublishHold] ${trigger}: publishing ${appId} (database held for publish)`);
      coordinator.scheduleAutoFlush(appId);
    }
    return appIds;
  } catch (err) {
    console.warn(`[PublishHold] ${trigger}: could not schedule held publishes: ${(err as Error).message}`);
    return [];
  }
}
