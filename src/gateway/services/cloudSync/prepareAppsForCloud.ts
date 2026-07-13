/**
 * Prepare published mini-apps for cloud after desktop sync.
 *
 * One user action ("Sync now" / pushAppNow) should make apps.papr.ai work after
 * a normal browser refresh. That requires three layers staying aligned:
 *
 * 1. Git repo — dist/app.js, backend/bundle.json, requirements.json, repo head marker
 * 2. Publish catalog — memory server allowlist for vault-resolve (auto-republish on drift)
 * 3. Edge cache — repo head marker + dist query versioning (cloud app host)
 *
 * This module handles layer 1 before commit. Layers 2–3 run in runPostSyncHooks().
 */

import * as path from "path";
import { ensureAppRequirementsSyncedWithBackend } from "../cloudAppRequirements.js";

export function appIdsFromSyncRelativePaths(
  relativePaths: readonly string[],
): string[] {
  const appIds = new Set<string>();
  for (const relativePath of relativePaths) {
    const match = relativePath.match(/^apps\/([^/]+)/);
    if (match?.[1]) {
      appIds.add(match[1]);
    }
  }
  return [...appIds];
}

/** Layer 1: requirements catalog, UI bundle, backend handler fingerprints. */
export async function prepareAppForCloudGitSync(
  paprDir: string,
  appId: string,
): Promise<void> {
  const appDir = path.join(paprDir, "apps", appId);
  try {
    await ensureAppRequirementsSyncedWithBackend(paprDir, appId);

    const { buildMiniApp } = await import("../../utils/miniAppBuild.js");
    const dist = await buildMiniApp(appDir);
    if (!dist.legacy && !dist.success) {
      console.warn(
        `[CloudSync] dist build failed for ${appId}:`,
        dist.errors.slice(0, 2).map((e) => e.message).join("; "),
      );
    }

    const { buildAppBackendBundle } = await import(
      "../../utils/miniAppBackendBuild.js"
    );
    const backend = await buildAppBackendBundle(appDir);
    if (!backend.success) {
      console.warn(
        `[CloudSync] backend bundle failed for ${appId}:`,
        backend.errors.join("; "),
      );
    }
  } catch (error) {
    console.warn(
      `[CloudSync] cloud prep skipped for ${appId}:`,
      (error as Error).message.slice(0, 120),
    );
  }
}

export async function prepareAppsForCloudGitSyncFromPaths(
  paprDir: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  const appIds = appIdsFromSyncRelativePaths(relativePaths);
  for (const appId of appIds) {
    await prepareAppForCloudGitSync(paprDir, appId);
  }
  return appIds;
}
