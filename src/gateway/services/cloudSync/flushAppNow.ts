/**
 * Ordered cross-layer flush for Upload now (SYNC_CONTRACT §12.1).
 *
 * Plan A (replica rollout): local migrations → cutover (legacy → replica) → git → publish.
 * Legacy-only: log catch-up → schema/row push → log catch-up → writer ops → publish.
 */

import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import {
  dedupeLinkedSourcesBySyncKey,
  discoverTursoLinkedSources,
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "../tursoLinkedSources.js";
import {
  pushLinkedSourceWithReplicaRouting,
  shouldSkipTursoPushInFlushForReplicaSource,
  shouldUseTursoReplicaForSource,
} from "../tursoReplica/tursoReplicaRouting.js";
import {
  awaitTursoPushInFlightForSyncKeys,
  cancelScheduledTursoPushForSyncKeys,
  withTursoPushInFlight,
} from "../tursoPushScheduler.js";
import { applyLocalMigrationsForApp } from "./applyLocalMigrationsForApp.js";
import { webReady } from "./webReady.js";
import { yieldEventLoop } from "./yieldEventLoop.js";
import {
  isLegacyWorkspaceRowSyncEnabled,
  shouldRunReplicaCutover,
} from "../../utils/tursoReplicaEnabled.js";

async function runPlanACutoverForUpload(appId: string): Promise<void> {
  const {
    runReplicaCutoverForAppUpload,
    formatReplicaCutoverUploadFailure,
  } = await import(
    "../tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
  );

  const { reportFlushProgress } = await import("./flushProgress.js");
  await reportFlushProgress(appId, {
    layer: "turso",
    label: "Migrating database to cloud sync…",
    detail: "One-time upgrade from legacy sync to Plan A replica (same Turso database).",
  });

  const batch = await runReplicaCutoverForAppUpload(appId);
  const failure = formatReplicaCutoverUploadFailure(batch);
  if (failure) {
    throw new Error(failure);
  }

  if (batch.succeeded > 0) {
    console.log(
      `[CloudSync] flushAppNow cutover succeeded for ${appId}: ` +
        `${batch.succeeded} database(s) now syncMode=replica`,
    );
  }
}

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

async function pushLinkedSourcesForFlush(
  pushSources: TursoLinkedSource[],
  syncKeys: string[],
  options?: { replicaOnly?: boolean; legacyOnly?: boolean },
): Promise<boolean> {
  cancelScheduledTursoPushForSyncKeys(syncKeys);
  await awaitTursoPushInFlightForSyncKeys(syncKeys);

  const sourcesNeedingTursoPush: TursoLinkedSource[] = [];
  for (const source of pushSources) {
    const appSource = linkedSourceAsAppDataSource(source);
    if (options?.replicaOnly && !shouldUseTursoReplicaForSource(appSource)) {
      continue;
    }
    if (options?.legacyOnly && shouldUseTursoReplicaForSource(appSource)) {
      continue;
    }
    const skip = await shouldSkipTursoPushInFlushForReplicaSource(source);
    if (skip) {
      console.log(
        `[CloudSync] flushAppNow skipping Turso push for ${source.alias} — replica auto-synced`,
      );
    } else {
      sourcesNeedingTursoPush.push(source);
    }
  }

  if (sourcesNeedingTursoPush.length === 0) {
    return false;
  }

  const { reportFlushProgress } = await import("./flushProgress.js");
  await reportFlushProgress(sourcesNeedingTursoPush[0]!.appId, {
    layer: "turso",
    label: "Syncing database to Turso…",
    detail: `Pushing ${sourcesNeedingTursoPush.length} linked database(s) via replica.`,
  });

  let tursoPushed = false;
  await withTursoPushInFlight(syncKeys, async () => {
    for (const source of sourcesNeedingTursoPush) {
      const pushResult = await pushLinkedSourceWithReplicaRouting(source);
      if (pushResult.ok) {
        tursoPushed = true;
      } else {
        throw new Error(
          `Turso push failed for ${source.alias}: ${pushResult.error ?? "unknown"}`,
        );
      }
    }
  });
  return tursoPushed;
}

export async function flushAppNow(
  sync: CloudSyncService,
  appId: string,
  options?: FlushAppNowOptions,
): Promise<FlushAppNowResult> {
  const paprDir = sync.getPaprDir();
  const appsRoot = path.join(paprDir, "apps");
  const planACutover = shouldRunReplicaCutover();
  const legacyRowSync = isLegacyWorkspaceRowSyncEnabled();

  console.log(
    `[CloudSync] flushAppNow appId=${appId} planACutover=${planACutover} legacyRowSync=${legacyRowSync}`,
  );

  const linkedSources = await discoverTursoLinkedSources(appsRoot);
  const appSources = linkedSources.filter((source) => source.appId === appId);
  const pushSources = dedupeLinkedSourcesBySyncKey(appSources);
  const syncKeys = pushSources.map((source) => linkedSourceSyncKey(source));

  let localMigrationsApplied: string[] = [];
  let tursoPushed = false;

  localMigrationsApplied = await applyLocalMigrationsForApp(appId, appsRoot);
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

  if (planACutover) {
    await runPlanACutoverForUpload(appId);
    await yieldEventLoop();

    // Cutover attaches replica sync; only push sources still on legacy workspace log.
    tursoPushed = await pushLinkedSourcesForFlush(pushSources, syncKeys, {
      legacyOnly: true,
    });
    await yieldEventLoop();
  } else if (legacyRowSync) {
    await catchUpAppLinkedSources(appSources);
    await yieldEventLoop();

    tursoPushed = await pushLinkedSourcesForFlush(pushSources, syncKeys);
    await yieldEventLoop();

    await catchUpAppLinkedSources(appSources);
    await yieldEventLoop();
  }

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
