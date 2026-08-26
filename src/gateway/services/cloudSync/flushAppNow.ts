/**
 * Ordered cross-layer flush for Upload now (SYNC_CONTRACT §12.1).
 *
 * log catch-up → schema/row push → log catch-up → writer ops → publish
 *
 * Row sync uses workspace log (not fingerprint Turso push in this path).
 * Jobs/databases metadata uses Mongo registry (not namespace git).
 *
 * Cloud-linked migrations ship via schema drift-heal (workspace log), not
 * direct SQLite apply — see applyLocalMigrationsForApp.
 */

import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import {
  dedupeLinkedSourcesBySyncKey,
  discoverTursoLinkedSources,
  linkedSourceSyncKey,
} from "../tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
import {
  awaitTursoPushInFlightForSyncKeys,
  cancelScheduledTursoPushForSyncKeys,
  withTursoPushInFlight,
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

async function catchUpAppLinkedSources(
  appSources: Awaited<ReturnType<typeof discoverTursoLinkedSources>>,
): Promise<void> {
  const { catchUpLinkedSourceFromWorkspaceLog } =
    await import("../syncV3/workspaceLogSync.js");
  for (const source of appSources) {
    await catchUpLinkedSourceFromWorkspaceLog(source);
  }
}

export async function flushAppNow(
  sync: CloudSyncService,
  appId: string,
  options?: FlushAppNowOptions,
): Promise<FlushAppNowResult> {
  const paprDir = sync.getPaprDir();
  const appsRoot = path.join(paprDir, "apps");

  console.log(`[CloudSync] flushAppNow (ordered) appId=${appId}`);

  const linkedSources = await discoverTursoLinkedSources(appsRoot);
  const appSources = linkedSources.filter((source) => source.appId === appId);
  const pushSources = dedupeLinkedSourcesBySyncKey(appSources);
  const syncKeys = pushSources.map((source) => linkedSourceSyncKey(source));

  await catchUpAppLinkedSources(appSources);
  await yieldEventLoop();

  const localMigrationsApplied = await applyLocalMigrationsForApp(appId, appsRoot);
  if (localMigrationsApplied.length > 0) {
    console.log(
      `[CloudSync] Applied local migrations for ${appId}: ${localMigrationsApplied.join(", ")}`,
    );
    const { reportFlushProgress } = await import("./flushProgress.js");
    await reportFlushProgress(appId, {
      layer: "turso",
      label: "Preparing local database…",
      detail: `Applied ${localMigrationsApplied.length} migration(s) locally before cloud sync.`,
    });
  }
  await yieldEventLoop();

  let tursoPushed = false;
  cancelScheduledTursoPushForSyncKeys(syncKeys);
  await awaitTursoPushInFlightForSyncKeys(syncKeys);

  const bridge = ensureTursoSyncBridge();
  await withTursoPushInFlight(syncKeys, async () => {
    for (const source of pushSources) {
      const syncKey = linkedSourceSyncKey(source);
      if (bridge.enabled) {
        const pushResult = await bridge.pushJob(syncKey);
        if (pushResult.status === "pushed") {
          tursoPushed = true;
        } else if (pushResult.status === "failed") {
          throw new Error(
            `Turso push failed for ${source.alias}: ${pushResult.error ?? "unknown"}`,
          );
        }
      } else {
        const { ensureReplicaReady } = await import("../syncV3/ensureReplicaReady.js");
        const readyResult = await ensureReplicaReady(source);
        if (readyResult.schemaShipped > 0 || readyResult.rowsShipped > 0) {
          tursoPushed = true;
        }
      }
    }
  });
  await yieldEventLoop();

  await catchUpAppLinkedSources(appSources);
  await yieldEventLoop();

  const { reportFlushProgress } = await import("./flushProgress.js");
  await reportFlushProgress(appId, {
    layer: "git",
    label: "Uploading app files…",
    detail: "Syncing code and migration files to the cloud repository.",
  });

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
