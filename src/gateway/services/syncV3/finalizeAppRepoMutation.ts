/**
 * Shared post-write pipeline for desktop flush and cloud sandbox writer pushes.
 *
 * prepare → platform manifest → writer ops
 * Catalog/App Files run via syncPublishedAppCatalogLayer after web-ready (desktop)
 * or after Turso bookends succeed (cloud sandbox).
 *
 * Revision notify is handled by appRepoCommittedFanout → appRepoRevisionSubscriber.
 */

import type { CloudSyncService } from "../CloudSyncService.js";
import { reconcilePlatformCatalogManifest } from "./platformCatalogManifest.js";
import { pushAppWriterOpsForPaprDir } from "./pushAppWriterOpsCore.js";
import { syncPublishedAppCatalogLayer } from "./syncPublishedAppCatalogLayer.js";

export type FinalizeAppRepoSource = "desktop-flush" | "cloud-sandbox";

export interface FinalizeAppRepoMutationOptions {
  source: FinalizeAppRepoSource;
  message?: string;
  author?: string;
  sync?: CloudSyncService;
  /** Skip catalog/App Files (writer-only push). Default for desktop flush until web-ready. */
  skipCatalog?: boolean;
  /** When catalog runs, refresh Mongo listing after a writer commit with file changes. */
  afterWriterChange?: boolean;
}

export interface FinalizeAppRepoMutationResult {
  appId: string;
  writerPushed: boolean;
  commitSha?: string;
  catalogSynced: boolean;
  catalogError?: string;
  /** Files held back by the batch budget — this app needs another flush. */
  deferred: number;
}

export async function finalizeAppRepoMutation(
  paprDir: string,
  appId: string,
  options: FinalizeAppRepoMutationOptions,
): Promise<FinalizeAppRepoMutationResult> {
  const { prepareAppForCloudGitSync } =
    await import("../cloudSync/prepareAppsForCloud.js");
  await prepareAppForCloudGitSync(paprDir, appId);
  await reconcilePlatformCatalogManifest(paprDir, appId);

  const author =
    options.author ??
    (options.source === "cloud-sandbox"
      ? "paprwork-cloud-sandbox"
      : "paprwork-desktop");

  const pushResult = await pushAppWriterOpsForPaprDir({
    paprDir,
    appId,
    message: options.message,
    author,
    skipPrepare: true,
    onSynced: options.sync
      ? (relativePaths) => {
          for (const relativePath of relativePaths) {
            options.sync!.markRelativePathSynced(relativePath);
          }
        }
      : undefined,
  });

  let catalogSynced = false;
  let catalogError: string | undefined;

  const writerPushed =
    pushResult.filesSent > 0 ||
    !!pushResult.commitSha ||
    pushResult.outboxReplayed > 0;

  if (!options.skipCatalog) {
    const catalogResult = await syncPublishedAppCatalogLayer(appId, {
      afterWriterChange: options.afterWriterChange ?? writerPushed,
    });
    catalogSynced = catalogResult.catalogSynced;
    catalogError = catalogResult.catalogError;
  }

  const { syncMetadataToCloudForFlush } = await import(
    "./syncMetadataForFlush.js"
  );
  await syncMetadataToCloudForFlush(paprDir, appId, pushResult.commitSha);

  return {
    appId,
    writerPushed,
    commitSha: pushResult.commitSha,
    catalogSynced,
    catalogError,
    deferred: pushResult.deferred,
  };
}
