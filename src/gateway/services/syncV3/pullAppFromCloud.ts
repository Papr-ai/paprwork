/**
 * Per-app Get updates — pull code from per-app repo + Turso rows from workspace log.
 */

import { reconcileLinkedSourcesFromCloud } from "../tursoSyncSession.js";
import { getCloudSyncService } from "../cloudSync/cloudSyncSingleton.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { pullAppCodeFromRepo, type PullAppCodeFromRepoResult } from "./pullAppCodeFromRepo.js";
import { applyRegistryMigrationsAfterPull } from "./syncPulledSchemaOwnerMigrations.js";

export interface PullAppFromCloudResult {
  appId: string;
  code: PullAppCodeFromRepoResult;
  tursoScheduled: boolean;
  turso?: Awaited<ReturnType<typeof reconcileLinkedSourcesFromCloud>>;
  /** Registry migrations applied after code pull (slug:file.sql). */
  registryMigrationsApplied?: string[];
}

/** After a successful Get updates, realign git fingerprint baseline with disk. */
function markAppCodeBaselineSynced(appId: string, code: PullAppCodeFromRepoResult): void {
  if (code.skipped || code.conflictFiles.length > 0) {
    return;
  }
  const sync = getCloudSyncService();
  if (!sync) {
    return;
  }
  sync.markRelativePathSynced(`apps/${appId}`);
}

export async function pullAppFromCloud(
  appId: string,
  options: {
    token: string | null;
    waitForTurso?: boolean;
    /** When false, always fetch remote HEAD (manual Get updates). */
    allowRecentSkip?: boolean;
  },
): Promise<PullAppFromCloudResult> {
  const code = await pullAppCodeFromRepo(appId, {
    token: options.token,
    allowRecentSkip: options.allowRecentSkip,
  });

  let registryMigrationsApplied: string[] | undefined;
  if (!code.skipped && code.conflictFiles.length === 0) {
    try {
      registryMigrationsApplied = await applyRegistryMigrationsAfterPull(appId);
      if (registryMigrationsApplied.length > 0) {
        console.log(
          `[PullAppFromCloud] ${appId}: applied registry migrations: ${registryMigrationsApplied.join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(
        `[PullAppFromCloud] ${appId}: registry migration apply failed:`,
        (error as Error).message,
      );
    }
  }

  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    markAppCodeBaselineSynced(appId, code);
    return { appId, code, tursoScheduled: false, registryMigrationsApplied };
  }

  if (options.waitForTurso) {
    const turso = await reconcileLinkedSourcesFromCloud(
      bridge,
      { appId },
      { trigger: "manual", assumeRemoteChanged: true, preferRemote: true },
    );
    markAppCodeBaselineSynced(appId, code);
    return { appId, code, tursoScheduled: false, turso, registryMigrationsApplied };
  }

  const { scheduleTursoPullForAppOpen } = await import("../tursoPullScheduler.js");
  scheduleTursoPullForAppOpen(appId);
  return { appId, code, tursoScheduled: true, registryMigrationsApplied };
}
