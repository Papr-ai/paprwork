/**
 * Per-app Get updates — pull code from per-app repo + Turso rows from workspace log.
 */

import { reconcileLinkedSourcesFromCloud } from "../tursoSyncSession.js";
import { getCloudSyncService } from "../cloudSync/cloudSyncSingleton.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import {
  pullAppCodeFromRepo,
  type PullAppCodeFromRepoResult,
  type PullConflictResolution,
} from "./pullAppCodeFromRepo.js";
import { applyRegistryMigrationsAfterPull } from "./syncPulledSchemaOwnerMigrations.js";
import { clearPendingAppUpdate, markPendingAppUpdate } from "./appRepoPendingUpdate.js";

export interface PullAppFromCloudResult {
  appId: string;
  code: PullAppCodeFromRepoResult;
  tursoScheduled: boolean;
  turso?: Awaited<ReturnType<typeof reconcileLinkedSourcesFromCloud>>;
  /** Registry migrations applied after code pull (slug:file.sql). */
  registryMigrationsApplied?: string[];
}

function shouldMarkAppCodeBaselineSynced(code: PullAppCodeFromRepoResult): boolean {
  if (code.conflictFiles.length > 0) {
    return false;
  }
  if ((code.keptLocalFiles?.length ?? 0) > 0) {
    // Keep mine: local edits still need publishing — don't mark the folder synced.
    return false;
  }
  if (!code.skipped) {
    return true;
  }
  return code.reason === "already at remote head";
}

/** After Get updates, clear stale git fingerprint so sync UI stops showing pending upload. */
function markAppCodeBaselineSynced(appId: string, code: PullAppCodeFromRepoResult): void {
  if (!shouldMarkAppCodeBaselineSynced(code)) {
    return;
  }
  clearPendingAppUpdate(appId);
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
    /**
     * Manual Get updates: ignore stale git/db flush flags only after writer HEAD
     * is confirmed ahead of local ack. Per-file merge still conflicts on edits.
     */
    preferCloudOverLocal?: boolean;
    /** Conflict handling — default "hold" (all-or-nothing). */
    resolution?: PullConflictResolution;
  },
): Promise<PullAppFromCloudResult> {
  const code = await pullAppCodeFromRepo(appId, {
    token: options.token,
    allowRecentSkip: options.allowRecentSkip,
    preferCloudOverLocal: options.preferCloudOverLocal,
    resolution: options.resolution,
  });

  if ((code.keptLocalFiles?.length ?? 0) > 0) {
    clearPendingAppUpdate(appId);
  }
  if (code.heldForConflicts && code.commitSha) {
    // Surface on the share bar chip + get_cloud_sync_status; waits for a choice.
    markPendingAppUpdate(
      {
        appId,
        commitSha: code.commitSha,
        reason: "conflicts with your edits",
        conflictFiles: code.conflictFiles,
      },
      async () => false,
    );
  }

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
