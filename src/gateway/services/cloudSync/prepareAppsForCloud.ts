/**
 * Prepare published mini-apps for cloud after desktop sync.
 *
 * One user action ("Sync now" / pushAppNow) should make apps.papr.ai work after
 * a normal browser refresh. That requires three layers staying aligned:
 *
 * 1. Git repo — dist/app.js, backend/bundle.json, requirements.json, repo head marker
 * 2. Publish catalog — memory server allowlist for vault-resolve (auto-republish on drift)
 * 3. Edge cache — per-app `.papr-cloud-revision` + dist query versioning (cloud app host)
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
    const {
      reconcileAppDataSourcesForPublish,
      detectCrossAppDependencies,
      writeCloudAppDependenciesFile,
    } = await import("../cloudAppResourceIntegrity.js");

    const reconcile = await reconcileAppDataSourcesForPublish(paprDir, appId);
    if (reconcile.changed) {
      console.log(
        `[CloudSync] Reconciled data-sources for ${appId}: +${reconcile.addedJobIds.length} jobs, -${reconcile.removedJobIds.length} stale job refs`,
      );
    }

    const dependencies = await detectCrossAppDependencies(paprDir, appId);
    await writeCloudAppDependenciesFile(paprDir, appId, dependencies);
    if (dependencies.apps.length > 0 || dependencies.databases.length > 0) {
      console.log(
        `[CloudSync] Declared ${dependencies.apps.length} cross-app and ${dependencies.databases.length} cross-db dependencies for ${appId}`,
      );
    }

    const { scrubAppDataSourcesForGitSync } = await import(
      "../portableDataSources.js"
    );
    await scrubAppDataSourcesForGitSync(appDir);

    const { writeLinkedDatabasesForApp } = await import(
      "./linkedDatabasesForCloud.js"
    );
    await writeLinkedDatabasesForApp(paprDir, appId);

    // Publisher's exact schema → migrations/snapshot.json (installers build
    // from it instead of replaying every migration). Isolated: a failure here
    // must not block the rest of publish prep.
    try {
      const { writeSchemaSnapshotsForApp } = await import(
        "./publishSchemaSnapshots.js"
      );
      await writeSchemaSnapshotsForApp(paprDir, appId);
    } catch (error) {
      console.warn(
        `[CloudSync] schema snapshot skipped for ${appId}:`,
        (error as Error).message.slice(0, 120),
      );
    }

    await ensureAppRequirementsSyncedWithBackend(paprDir, appId);

    // Agent-job instructions carry the app's own id as literal text. Convert
    // exactly that id (nothing else) to {{papr.app_id}} so every copy runs with
    // its own id and nothing has to be rewritten at install or proposal time.
    try {
      const { getJobsService } = await import("../JobsService.js");
      const { portableAppIdInText } = await import("../jobs/appIdPlaceholder.js");
      const { resolveAppDependentJobIds } = await import("./resolveAppDependentJobs.js");
      const jobs = getJobsService();
      for (const jobId of resolveAppDependentJobIds(paprDir, appId)) {
        const job = await jobs.getJob(jobId);
        if (!job?.command || !(job.appIds ?? []).includes(appId)) continue;
        const portable = portableAppIdInText(job.command, appId);
        if (portable.replaced > 0) {
          await jobs.updateJob(jobId, { command: portable.text });
          console.log(`[CloudSync] ${jobId}: ${portable.replaced} app id(s) -> {{papr.app_id}}`);
        }
      }
    } catch (error) {
      console.warn(
        `[CloudSync] app-id placeholder skipped for ${appId}:`,
        (error as Error).message.slice(0, 120),
      );
    }

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

    const { writeAppCloudRevisionMarker } = await import(
      "./cloudAppRevisionMarker.js"
    );
    writeAppCloudRevisionMarker(appDir);

    const { writeCloudAppMeta } = await import("./cloudAppMeta.js");
    await writeCloudAppMeta(paprDir, appId);

    const { uploadAppDbConfigToCloud } = await import(
      "../syncV3/appDbConfigUpload.js"
    );
    void uploadAppDbConfigToCloud(paprDir, appId).catch(() => {});
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
