/**
 * Remove sync V3 / cloud publish artifacts when a mini-app is deleted.
 */

import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "./DatabaseRegistryService.js";
import { removeCachedAppRepoRecord } from "./syncV3/appRepoRegistryCache.js";
import { removeAppRepoCommitCursor } from "./syncV3/appRepoCommittedFanout.js";
import { removeAppFromOidCache } from "./syncV3/OidCache.js";
import { removeOutboxEntriesForApp } from "./syncV3/SyncOutbox.js";

export interface DeleteAppSyncArtifactsResult {
  removedRepoRegistry: boolean;
  removedCommitCursor: boolean;
  removedOidCache: boolean;
  removedOutboxEntries: number;
  tombstonedSchemaOwnerDbs: number;
}

export async function deleteAppSyncArtifacts(
  appId: string,
  paprHome?: string,
): Promise<DeleteAppSyncArtifactsResult> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return {
      removedRepoRegistry: false,
      removedCommitCursor: false,
      removedOidCache: false,
      removedOutboxEntries: 0,
      tombstonedSchemaOwnerDbs: 0,
    };
  }

  try {
    const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
    getSyncCoordinator()?.forgetDeletedApp(trimmed);
  } catch {
    /* coordinator optional during tests */
  }

  const removedRepoRegistry = await removeCachedAppRepoRecord(trimmed, paprHome);
  const removedCommitCursor = await removeAppRepoCommitCursor(trimmed, paprHome);
  const removedOidCache = await removeAppFromOidCache(trimmed, paprHome);
  const removedOutboxEntries = await removeOutboxEntriesForApp(trimmed);

  let tombstonedSchemaOwnerDbs = 0;
  try {
    await initializeDatabaseRegistry();
    const registry = getDatabaseRegistryService();
    const owned = registry.listBySchemaOwnerApp(trimmed);
    for (const record of owned) {
      await registry.tombstone(record.dbId);
      tombstonedSchemaOwnerDbs += 1;
    }
  } catch (error) {
    console.warn(
      `[deleteApp] Could not tombstone schema-owner registry DBs for ${trimmed}:`,
      error instanceof Error ? error.message : error,
    );
  }

  if (
    removedRepoRegistry ||
    removedCommitCursor ||
    removedOidCache ||
    removedOutboxEntries > 0 ||
    tombstonedSchemaOwnerDbs > 0
  ) {
    console.log(
      `[deleteApp] Cleared sync artifacts for ${trimmed}` +
        ` (repo=${removedRepoRegistry}, cursor=${removedCommitCursor}, oid=${removedOidCache}, outbox=${removedOutboxEntries}, schemaOwnerDbs=${tombstonedSchemaOwnerDbs})`,
    );
  }

  return {
    removedRepoRegistry,
    removedCommitCursor,
    removedOidCache,
    removedOutboxEntries,
    tombstonedSchemaOwnerDbs,
  };
}
