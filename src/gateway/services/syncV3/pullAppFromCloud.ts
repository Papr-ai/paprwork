/**
 * Per-app Get updates — pull code from per-app repo + Turso rows from workspace log.
 */

import { reconcileLinkedSourcesFromCloud } from "../tursoSyncSession.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { pullAppCodeFromRepo, type PullAppCodeFromRepoResult } from "./pullAppCodeFromRepo.js";

export interface PullAppFromCloudResult {
  appId: string;
  code: PullAppCodeFromRepoResult;
  tursoScheduled: boolean;
  turso?: Awaited<ReturnType<typeof reconcileLinkedSourcesFromCloud>>;
}

export async function pullAppFromCloud(
  appId: string,
  options: { token: string | null; waitForTurso?: boolean },
): Promise<PullAppFromCloudResult> {
  const code = await pullAppCodeFromRepo(appId, { token: options.token });

  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return { appId, code, tursoScheduled: false };
  }

  if (options.waitForTurso) {
    const turso = await reconcileLinkedSourcesFromCloud(
      bridge,
      { appId },
      { trigger: "manual" },
    );
    return { appId, code, tursoScheduled: false, turso };
  }

  const { scheduleTursoPullForAppOpen } = await import("../tursoPullScheduler.js");
  scheduleTursoPullForAppOpen(appId);
  return { appId, code, tursoScheduled: true };
}
