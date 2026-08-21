/**
 * Ordered cross-layer flush for Upload now (SYNC_CONTRACT §12.1).
 *
 * migrate → writer ops (app + linked jobs + owner migrations) → publish
 *
 * Row sync uses workspace log (not fingerprint Turso push in this path).
 * Jobs/databases metadata uses Mongo registry (not namespace git).
 */

import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import {
  discoverTursoLinkedSources,
  linkedSourceSyncKey,
} from "../tursoLinkedSources.js";
import {
  awaitTursoPushInFlightForSyncKeys,
  cancelScheduledTursoPushForSyncKeys,
} from "../tursoPushScheduler.js";
import { applyLocalMigrationsForApp } from "./applyLocalMigrationsForApp.js";
import { webReady } from "./webReady.js";
import { yieldEventLoop } from "./yieldEventLoop.js";

export interface FlushAppNowResult {
  appId: string;
  localMigrationsApplied: string[];
  tursoPushed: boolean;
  webReady: boolean;
  webReadyReason?: string;
  published: boolean;
  catalogError?: string;
}


export interface FlushAppNowOptions {
  skipTursoReschedule?: boolean;
}

export async function flushAppNow(
  sync: CloudSyncService,
  appId: string,
  options?: FlushAppNowOptions,
): Promise<FlushAppNowResult> {
  const paprDir = sync.getPaprDir();
  const appsRoot = path.join(paprDir, "apps");

  console.log(`[CloudSync] flushAppNow (ordered) appId=${appId}`);

  const localMigrationsApplied = await applyLocalMigrationsForApp(appId, appsRoot);
  if (localMigrationsApplied.length > 0) {
    console.log(
      `[CloudSync] Applied local migrations for ${appId}: ${localMigrationsApplied.join(", ")}`,
    );
  }
  await yieldEventLoop();

  let tursoPushed = false;
  const linkedSources = await discoverTursoLinkedSources(appsRoot);
  const appSources = linkedSources.filter((source) => source.appId === appId);
  const syncKeys = appSources.map((source) => linkedSourceSyncKey(source));
  cancelScheduledTursoPushForSyncKeys(syncKeys);
  await awaitTursoPushInFlightForSyncKeys(syncKeys);

  for (const source of appSources) {
    const { ensureReplicaReady } = await import("../syncV3/ensureReplicaReady.js");
    const readyResult = await ensureReplicaReady(source);
    if (readyResult.schemaShipped > 0 || readyResult.rowsShipped > 0) {
      tursoPushed = true;
    }
  }
  await yieldEventLoop();

  const { catchUpLinkedSourceFromWorkspaceLog } =
    await import("../syncV3/workspaceLogSync.js");

  for (const source of appSources) {
    await catchUpLinkedSourceFromWorkspaceLog(source);
  }
  await yieldEventLoop();

  let writerPushed = false;
  try {
    const { finalizeAppRepoMutation } = await import(
      "../syncV3/finalizeAppRepoMutation.js"
    );
    const finalizeResult = await finalizeAppRepoMutation(paprDir, appId, {
      source: "desktop-flush",
      sync,
      skipCatalog: true,
    });
    writerPushed = finalizeResult.writerPushed;
  } catch (err) {
    const { AppOpsConflictError } = await import("../syncV3/AppOpsClient.js");
    if (err instanceof AppOpsConflictError) {
      // Preserve the typed conflict (appId + per-path artifacts) so callers
      // can surface "file changed on server" instead of a generic failure.
      throw err;
    }
    throw new Error(`App sync failed: ${(err as Error).message}`);
  }
  await yieldEventLoop();

  const ready = await webReady(appId, paprDir);
  let published = false;
  let catalogError: string | undefined;

  if (ready.ready) {
    const { syncPublishedAppCatalogLayer } = await import(
      "../syncV3/syncPublishedAppCatalogLayer.js"
    );
    const catalogResult = await syncPublishedAppCatalogLayer(appId, {
      afterWriterChange: writerPushed,
    });
    catalogError = catalogResult.catalogError;

    if (catalogError) {
      console.warn(
        `[CloudSync] flushAppNow web-ready but catalog sync failed for ${appId}: ${catalogError}`,
      );
    } else {
      sync.markAppForPostFlushHooks(appId);
      await sync.runPostFlushHooks({
        skipTursoReschedule: options?.skipTursoReschedule ?? true,
      });
      published = true;
      console.log(`[CloudSync] flushAppNow verified + web-ready for ${appId}`);
    }
  } else {
    console.warn(
      `[CloudSync] flushAppNow complete but not web-ready for ${appId}: ${ready.reason ?? "unknown"}${ready.detail ? ` (${ready.detail})` : ""}`,
    );
  }

  return {
    appId,
    localMigrationsApplied,
    tursoPushed,
    webReady: ready.ready,
    webReadyReason: ready.reason,
    published,
    catalogError,
  };
}
