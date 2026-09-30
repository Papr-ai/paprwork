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

export interface ContributeApproveFollowUpResult {
  appId?: string;
  pulled: boolean;
  codeSkipped?: boolean;
  codeReason?: string;
  conflictFiles?: string[];
  error?: string;
}

/** Pull per-app writer repo into disk; never push local over a freshly merged remote. */
export async function followUpContributeApprove(
  sourceAppId: string | undefined,
): Promise<ContributeApproveFollowUpResult> {
  notifyCloudChangeRequestsStale(sourceAppId);

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
    return {
      appId,
      pulled: true,
      codeSkipped: result.code.skipped,
      codeReason: result.code.reason,
      conflictFiles: result.code.conflictFiles,
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
