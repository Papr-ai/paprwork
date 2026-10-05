/**
 * After publish/sharing changes: persist allowlist where Cloud App Host can read it.
 */

import path from "path";
import type { CloudPublishAppPrefs } from "./cloudPublishPrefs.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import type { CloudPublishConfig } from "./CloudAppPublishService.js";
import { memoryShareAllowlistBodyFromPrefs } from "./cloudShareAllowlistMemory.js";
import { sharePeopleAllowlistFromFields } from "./appRuntime/sharePeopleAllowlistFields.js";
import { writeSharePeopleAllowlistRepoFile } from "./appRuntime/sharePeopleAllowlistRepoArtifact.js";

export async function persistSharePeopleAllowlistForCloudHost(
  paprDir: string,
  appId: string,
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): Promise<boolean> {
  const appDir = path.join(paprDir, "apps", appId);
  try {
    return await writeSharePeopleAllowlistRepoFile(appDir, prefs);
  } catch (error) {
    console.warn(
      `[CloudPublish] share-people-allowlist.json write failed for ${appId}:`,
      error instanceof Error ? error.message.slice(0, 120) : String(error),
    );
    return false;
  }
}

export function shareAllowlistNotifyPayload(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): {
  allowedUserIds: string[];
  allowedEmails: string[];
  allowedEmailDomains: string[];
} {
  return memoryShareAllowlistBodyFromPrefs(prefs);
}

export function scheduleCloudAppHostAccessInvalidation(
  paprDir: string,
  appId: string,
  config: Pick<CloudPublishConfig, "shareUrl" | "slug">,
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): void {
  // Push only when the allowlist file actually changed. Pushing on every call
  // looped: publish → catalog update → push → publish… every ~20s per shared app.
  void persistSharePeopleAllowlistForCloudHost(paprDir, appId, prefs)
    .then(async (changed) => {
      if (!changed) return;
      const { getCloudSyncService } = await import("./CloudSyncService.js");
      getCloudSyncService()?.pushAppNowInBackground(appId);
    })
    .catch(() => {
      /* optional */
    });

  void import("./cloudSync/notifyCloudAppRevision.js")
    .then(({ notifyCloudAppAccessUpdated, resolvePublishRouteForNotify }) => {
      const route = resolvePublishRouteForNotify({
        shareUrl: config.shareUrl,
        slug: config.slug,
        namespaceId: readActiveWorkspacePointer()?.namespaceId,
      });
      if (!route) {
        return;
      }
      const allowlist = sharePeopleAllowlistFromFields(prefs);
      return notifyCloudAppAccessUpdated({
        ...route,
        appId,
        ...(allowlist ? shareAllowlistNotifyPayload(prefs) : {}),
      });
    })
    .catch((error: unknown) => {
      console.warn(
        "[CloudPublish] App access cache notify skipped:",
        error instanceof Error ? error.message.slice(0, 120) : String(error),
      );
    });
}
