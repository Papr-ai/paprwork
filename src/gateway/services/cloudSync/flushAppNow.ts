/**
 * Ordered cross-layer flush for Upload now (SYNC_CONTRACT §12.1).
 *
 * migrate → Turso schema+rows → verify Turso → git → verify full → publish if web-ready
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
import {
  assertAppPushVerified,
  verifyAppPushConvergence,
} from "./postPushVerify.js";
import { runConvergenceCheckForApp } from "./convergenceChecker.js";
import { webReady } from "./webReady.js";
import { yieldEventLoop } from "./yieldEventLoop.js";

export interface FlushAppNowResult {
  appId: string;
  localMigrationsApplied: string[];
  tursoPushed: boolean;
  webReady: boolean;
  webReadyReason?: string;
  published: boolean;
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

  const errors: string[] = [];
  let tursoPushed = false;

  const bridge = (await import("../TursoSyncBridge.js")).getTursoSyncBridge();
  if (bridge) {
    try {
      const linkedSources = await discoverTursoLinkedSources(appsRoot);
      const syncKeys = linkedSources
        .filter((source) => source.appId === appId)
        .map((source) => linkedSourceSyncKey(source));
      cancelScheduledTursoPushForSyncKeys(syncKeys);
      await awaitTursoPushInFlightForSyncKeys(syncKeys);

      const summary = await bridge.pushAppLinkedSources(appId);
      tursoPushed = summary.pushed > 0 || summary.skipped > 0;
      if (summary.failed > 0) {
        const tursoErrors = summary.results
          .filter((result) => result.error)
          .map((result) => result.error)
          .join("; ");
        errors.push(
          tursoErrors.length > 0
            ? `Database sync to Turso failed: ${tursoErrors}`
            : "Database sync to Turso failed",
        );
      }
    } catch (err) {
      errors.push(`Database sync to Turso failed: ${(err as Error).message}`);
    }
  }
  await yieldEventLoop();

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const tursoVerify = await verifyAppPushConvergence(
    appId,
    paprDir,
    (args) => sync.runGit(args),
    { skipGit: true },
  );
  if (!tursoVerify.ok) {
    throw new Error(
      `Turso verify failed for ${appId}: ${tursoVerify.errors.join("; ")}`,
    );
  }
  await yieldEventLoop();

  try {
    await sync.pushGitNow({ appId, skipPostSyncHooks: true });
  } catch (err) {
    throw new Error(`Git sync failed: ${(err as Error).message}`);
  }
  await yieldEventLoop();

  await assertAppPushVerified(appId, paprDir, (args) => sync.runGit(args));
  await yieldEventLoop();

  await runConvergenceCheckForApp(appId, appsRoot, paprDir);
  await yieldEventLoop();

  const ready = await webReady(appId, paprDir);
  let published = false;

  if (ready.ready) {
    sync.markAppForPostFlushHooks(appId);
    await sync.runPostFlushHooks({
      skipTursoReschedule: options?.skipTursoReschedule ?? true,
    });
    published = true;
    console.log(`[CloudSync] flushAppNow verified + web-ready for ${appId}`);
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
  };
}
