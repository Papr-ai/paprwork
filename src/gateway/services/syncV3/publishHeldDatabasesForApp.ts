/**
 * Held-database publish for one app (option A: database first, then code).
 *
 *   1. heldDatabasesForApp — which of the app's databases hold a breaking migration;
 *   2. publishHeldDatabasesForApp — migrate + verify + replay + release, BEFORE the
 *      code push, so a failure leaves the old code and old schema live together;
 *   3. switchHostToCommit — after the code push, tell the host to serve that SHA.
 *
 * While a hold exists, background code uploads skip the app (see
 * finalizeAppRepoMutation), so new code can't go live ahead of its database.
 */

import { listReplicaPublishHolds, type ReplicaPublishHold } from "../tursoReplica/replicaPublishHold.js";

export async function heldDatabasesForApp(paprDir: string, appId: string): Promise<ReplicaPublishHold[]> {
  const holds = listReplicaPublishHolds();
  if (holds.length === 0) return [];
  const { listAppLinkedSyncKeys } = await import("../tursoLinkedSources.js");
  const linked = listAppLinkedSyncKeys(appId, paprDir);
  return holds.filter((h) => (h.dbId && linked.has(h.dbId)) || h.appId === appId);
}

export async function publishHeldDatabasesForApp(
  paprDir: string,
  appId: string,
  onProgress?: (label: string, detail?: string) => void,
): Promise<Array<{ dbId: string; migrated: string[]; replayed: number }>> {
  const mine = await heldDatabasesForApp(paprDir, appId);
  if (mine.length === 0) return [];

  const { getDatabaseRegistryService, tursoNameForRecord } = await import("../DatabaseRegistryService.js");
  const { publishHeldDatabase, defaultHeldPublishDeps } = await import(
    "../tursoReplica/publishHeldDatabases.js"
  );
  const deps = await defaultHeldPublishDeps();
  const done: Array<{ dbId: string; migrated: string[]; replayed: number }> = [];

  for (const hold of mine) {
    const record = hold.dbId ? getDatabaseRegistryService().getById(hold.dbId) : undefined;
    if (!record) {
      throw new Error(`Held database ${hold.dbId ?? hold.localPath} is not in the registry`);
    }
    onProgress?.(
      "Publishing database change…",
      `Applying ${hold.migrations.length} schema change(s) to the cloud copy of ${record.label ?? record.dbId}.`,
    );
    const result = await publishHeldDatabase(hold, tursoNameForRecord(record), deps);
    done.push({ dbId: result.dbId, migrated: result.migrated, replayed: result.replayed });
  }
  return done;
}

/** Point the live app at the commit that carries the new code (S5: by SHA). */
export async function switchHostToCommit(
  appId: string,
  commitSha: string | undefined,
  onProgress?: (label: string, detail?: string) => void,
): Promise<void> {
  if (!commitSha) return;
  onProgress?.("Switching the live app over…", "Serving the new code with the new database.");
  const { getCloudAppPublishService } = await import("../CloudAppPublishService.js");
  const { notifyCloudAppRevisionUpdated, parsePublishedAppRoute } = await import(
    "../cloudSync/notifyCloudAppRevision.js"
  );
  const status = await getCloudAppPublishService().getCloudPublishStatus(appId);
  const route = status.published ? parsePublishedAppRoute(status.shareUrl) : null;
  if (route) {
    await notifyCloudAppRevisionUpdated({ ...route, commitSha });
  }
}
