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
  /** Live step labels (share chip). */
  onProgress?: (label: string, detail?: string) => void;
}

async function shouldUsePublishWorker(): Promise<boolean> {
  const { isPublishWorkerEnabled } = await import(
    "../publishWorker/PublishWorkerClient.js"
  );
  return isPublishWorkerEnabled();
}

/**
 * Run the writer upload in the publish worker, then apply the parts that must
 * live in the gateway: synced marks, commit fan-out, conflict list, and the
 * same error classes the in-process path throws.
 */
async function pushViaPublishWorker(
  paprDir: string,
  appId: string,
  opts: {
    message?: string;
    author: string;
    onSynced?: (paths: readonly string[]) => void;
    onProgress?: (label: string, detail?: string) => void;
  },
) {
  const { getPaprApiKey } = await import("../../utils/keyResolver.js");
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured. Login with Papr first.");
  }
  const { getPublishWorkerClient, PublishWorkerRequestError } = await import(
    "../publishWorker/PublishWorkerClient.js"
  );
  try {
    const line = await getPublishWorkerClient().push(
      { appId, paprDir, apiKey, message: opts.message, author: opts.author },
      opts.onProgress,
    );
    // Before fan-out: the revision subscriber must see these as our own commits.
    const { rememberOwnAppCommit } = await import("./appRepoPendingUpdate.js");
    for (const sha of line.ownCommits ?? []) {
      rememberOwnAppCommit(appId, sha);
    }
    opts.onSynced?.(line.syncedPaths);
    if (line.committed.length > 0) {
      const { fanoutAppRepoCommitted } = await import("./appRepoCommittedFanout.js");
      for (const event of line.committed) {
        await fanoutAppRepoCommitted(event);
      }
    }
    return line.result;
  } catch (err) {
    if (err instanceof PublishWorkerRequestError) {
      const detail = err.detail;
      const { AppOpsConflictError, AppOpsClientError } = await import("./AppOpsClient.js");
      if (detail.name === "AppOpsConflictError" && "artifacts" in detail) {
        const { rememberWriterConflicts } = await import("./writerConflict.js");
        rememberWriterConflicts(appId, detail.artifacts);
        throw new AppOpsConflictError(appId, { conflict: true, artifacts: detail.artifacts });
      }
      if (detail.name === "AppOpsClientError" && "status" in detail) {
        const wrapped = new AppOpsClientError(appId, detail.status, "");
        wrapped.message = detail.message;
        throw wrapped;
      }
      const plain = new Error(detail.message);
      plain.name = detail.name;
      throw plain;
    }
    throw err;
  }
}

export interface FinalizeAppRepoMutationResult {
  appId: string;
  writerPushed: boolean;
  commitSha?: string;
  catalogSynced: boolean;
  catalogError?: string;
  /** Memory Mongo metadata still catching up (outbox will retry). */
  metadataSyncWarnings?: string[];
  /** Files held back by the batch budget — this app needs another flush. */
  deferred: number;
  /** Databases whose held breaking migrations went out with this publish. */
  heldDatabases?: Array<{ dbId: string; migrated: string[]; replayed: number }>;
  /** Background upload skipped: a database change is waiting for the next publish. */
  heldForPublish?: boolean;
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

  const onSynced = options.sync
    ? (relativePaths: readonly string[]) => {
        for (const relativePath of relativePaths) {
          options.sync!.markRelativePathSynced(relativePath);
        }
      }
    : undefined;

  // Breaking migration waiting (option A): the database goes first, the code
  // only after it is verified. Background uploads don't publish, so they skip
  // the app entirely — the files stay dirty and go out with the next publish.
  const heldModule = await import("./publishHeldDatabasesForApp.js");
  const heldForApp = await heldModule.heldDatabasesForApp(paprDir, appId);
  if (heldForApp.length > 0 && options.source !== "desktop-flush") {
    console.log(
      `[PublishHold] ${appId}: database change waiting — code upload deferred to the next publish`,
    );
    return {
      appId,
      writerPushed: false,
      catalogSynced: false,
      deferred: 0,
      heldForPublish: true,
    };
  }
  const held =
    heldForApp.length > 0
      ? await heldModule.publishHeldDatabasesForApp(paprDir, appId, options.onProgress)
      : [];

  const pushResult =
    options.source === "desktop-flush" && (await shouldUsePublishWorker())
      ? await pushViaPublishWorker(paprDir, appId, {
          message: options.message,
          author,
          onSynced,
          onProgress: options.onProgress,
        })
      : await pushAppWriterOpsForPaprDir({
          paprDir,
          appId,
          message: options.message,
          author,
          skipPrepare: true,
          onSynced,
          onProgress: options.onProgress,
        });

  // Database already published above: switch the host to the new commit right
  // away, before catalog/metadata uploads (QA: switching after them cost ~17s
  // of old code on the new schema).
  if (held.length > 0) {
    await heldModule.switchHostToCommit(appId, pushResult.commitSha, options.onProgress);
  }

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

  options.onProgress?.(
    "Uploading app database config…",
    "Sending which databases this app uses.",
  );
  const { syncMetadataToCloudForFlush } = await import(
    "./syncMetadataForFlush.js"
  );
  const metadataSync = await syncMetadataToCloudForFlush(
    paprDir,
    appId,
    pushResult.commitSha,
    options.onProgress,
  );


  return {
    appId,
    writerPushed,
    commitSha: pushResult.commitSha,
    ...(held.length > 0 ? { heldDatabases: held } : {}),
    catalogSynced,
    catalogError,
    metadataSyncWarnings:
      metadataSync.warnings.length > 0 ? metadataSync.warnings : undefined,
    deferred: pushResult.deferred,
  };
}
