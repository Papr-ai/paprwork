/**
 * Per-app Get updates — pull code from per-app repo + Turso rows from workspace log.
 */

import { reconcileLinkedSourcesFromCloud } from "../tursoSyncSession.js";
import { getCloudSyncService } from "../cloudSync/cloudSyncSingleton.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { pullAppCodeFromRepo, type PullAppCodeFromRepoResult } from "./pullAppCodeFromRepo.js";

export interface PullAppFromCloudResult {
  appId: string;
  code: PullAppCodeFromRepoResult;
  tursoScheduled: boolean;
  turso?: Awaited<ReturnType<typeof reconcileLinkedSourcesFromCloud>>;
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
  options: { token: string | null; waitForTurso?: boolean },
): Promise<PullAppFromCloudResult> {
  const code = await pullAppCodeFromRepo(appId, { token: options.token });

  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    markAppCodeBaselineSynced(appId, code);
    return { appId, code, tursoScheduled: false };
  }

  if (options.waitForTurso) {
    const turso = await reconcileLinkedSourcesFromCloud(
      bridge,
      { appId },
      { trigger: "manual", assumeRemoteChanged: true, preferRemote: true },
    );
    markAppCodeBaselineSynced(appId, code);
    return { appId, code, tursoScheduled: false, turso };
  }

  const { scheduleTursoPullForAppOpen } = await import("../tursoPullScheduler.js");
  scheduleTursoPullForAppOpen(appId);
  return { appId, code, tursoScheduled: true };
}
