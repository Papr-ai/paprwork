/**
 * After an owner approves a contribute-back PR: pull merged writer-repo code
 * into the local app folder and notify the UI (inbox badge, publish bar).
 */

import { broadcast } from "../websocket/index.js";
import { getCloudSyncService } from "./cloudSync/cloudSyncSingleton.js";
import { notifyCloudSyncItemsStale } from "./cloudSync/cloudSyncBroadcast.js";
import { pullAppFromCloud } from "./syncV3/pullAppFromCloud.js";

export function notifyCloudChangeRequestsStale(sourceAppId?: string): void {
  broadcast({
    type: "cloud-change-requests:stale",
    data: sourceAppId?.trim() ? { sourceAppId: sourceAppId.trim() } : {},
  });
}

export function readSourceAppIdFromApproveBody(
  body: Record<string, unknown>,
): string | undefined {
  const direct = body.sourceAppId;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const snake = body.source_app_id;
  if (typeof snake === "string" && snake.trim()) {
    return snake.trim();
  }
  return undefined;
}

/** Contributor's local track/fork copy id, when the resolve response carries it. */
export function readInstalledAppIdFromResolveBody(
  body: Record<string, unknown>,
): string | undefined {
  for (const key of ["installedAppId", "installed_app_id"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Tell the contributor's publish bar (keyed by the installed app id, not the
 * source app id) to re-read its sent proposals. Only reaches a renderer on
 * this machine; other machines pick it up on the periodic pull tick.
 */
export function notifyContributorProposalResolved(
  installedAppId: string | undefined,
): void {
  const id = installedAppId?.trim();
  if (id) {
    notifyCloudSyncItemsStale(id);
  }
}

export interface ContributeApproveFollowUpResult {
  appId?: string;
  pulled: boolean;
  codeSkipped?: boolean;
  codeReason?: string;
  conflictFiles?: string[];
  /** Build outputs are being rebuilt + published from the merged source. */
  regenerating?: boolean;
  error?: string;
}

/**
 * Rebuild platform outputs from the freshly merged source, then publish them.
 * Build first: the flush skips apps whose files match the last sync, and the
 * rebuilt dist/ is what makes this app differ.
 */
export function regenerateBuildOutputsInBackground(appId: string): boolean {
  const sync = getCloudSyncService();
  if (!sync) return false;
  void (async () => {
    const { prepareAppForCloudGitSync } = await import(
      "./cloudSync/prepareAppsForCloud.js"
    );
    await prepareAppForCloudGitSync(sync.getPaprDir(), appId);
    await sync.pushAppNow(appId);
    notifyCloudSyncItemsStale(appId);
  })().catch((err: Error) => {
    console.warn(
      `[Gateway] Rebuild after accepted proposal failed for ${appId}:`,
      err.message.slice(0, 200),
    );
  });
  return true;
}

/** Pull per-app writer repo into disk; never push local over a freshly merged remote. */
export async function followUpContributeApprove(
  sourceAppId: string | undefined,
  installedAppId?: string,
): Promise<ContributeApproveFollowUpResult> {
  notifyCloudChangeRequestsStale(sourceAppId);
  // The approval is final on the server whether or not our pull succeeds.
  notifyContributorProposalResolved(installedAppId);

  const appId = sourceAppId?.trim();
  if (!appId) {
    return { pulled: false, error: "approve response missing sourceAppId" };
  }

  try {
    const sync = getCloudSyncService();
    const token = sync ? await sync.ensureFreshToken() : null;
    const result = await pullAppFromCloud(appId, {
      token,
      waitForTurso: true,
      allowRecentSkip: false,
      preferCloudOverLocal: true,
    });
    notifyCloudSyncItemsStale(appId);
    const conflictFiles = result.code.conflictFiles ?? [];
    // Proposals no longer carry build outputs (dist/, backend/bundle.json,
    // __papr__/app-meta.json) — rebuild them from the merged source and
    // publish, so the live app serves the accepted code.
    const regenerating =
      conflictFiles.length === 0 && sync
        ? regenerateBuildOutputsInBackground(appId)
        : false;
    return {
      appId,
      pulled: true,
      codeSkipped: result.code.skipped,
      codeReason: result.code.reason,
      conflictFiles,
      regenerating,
    };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(
      `[Gateway] Contribute approve follow-up pull failed for ${appId}:`,
      message.slice(0, 200),
    );
    return { appId, pulled: false, error: message };
  }
}
