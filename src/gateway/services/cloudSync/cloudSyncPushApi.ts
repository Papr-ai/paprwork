/**
 * Manual / UI push entry points (Sync V3 — writer ops + workspace log).
 */

import * as path from "path";
import { probeGitInstalled } from "./gitRunner.js";
import {
  buildAuthedUrl,
  hasWorkspaceGitAtRoot,
} from "./cloudSyncToken.js";
import type { CloudSyncHostService } from "./cloudSyncHost.js";
import type { CloudSyncService } from "../CloudSyncService.js";
import type { PushGitScopedResult } from "./cloudSyncTypes.js";

const COMPOSER_PREPARE_COOLDOWN_MS = 120_000;
const composerPrepareAtByService = new WeakMap<CloudSyncService, number>();

export async function pushNow(sync: CloudSyncHostService): Promise<void> {
  await pushGitNow(sync);
  const bridge = (await import("../TursoSyncBridge.js")).ensureTursoSyncBridge();
  if (bridge.enabled) {
    await bridge.pushDirtyLinkedSources();
  }
}

export async function pushAppDependentPathsNow(
  sync: CloudSyncHostService,
  appId: string,
): Promise<PushGitScopedResult> {
  const { pushWorkspaceV3Now } = await import("./pushV3Now.js");
  return pushWorkspaceV3Now(sync, { appId }, "manual");
}

export async function pushGitNow(
  sync: CloudSyncHostService,
  options?: {
    appId?: string;
    jobId?: string;
    skipPostSyncHooks?: boolean;
  },
): Promise<PushGitScopedResult> {
  if (sync.stopped || !sync.isWriteContextValid("pushGitNow")) {
    return { pushedPaths: [], skippedPaths: [], scope: "workspace" };
  }
  if (sync.pushTimer) {
    clearTimeout(sync.pushTimer);
    sync.pushTimer = null;
  }

  const appId = options?.appId?.trim();
  const jobId = options?.jobId?.trim();
  const scopePaths = [
    ...(appId ? [path.join("apps", appId)] : []),
    ...(jobId ? [path.join("Jobs", jobId)] : []),
  ];
  if (scopePaths.length > 0) {
    sync.removePathsFromQueue(scopePaths);
  }

  const { pushWorkspaceV3Now } = await import("./pushV3Now.js");
  const result = await pushWorkspaceV3Now(
    sync,
    {
      appId: appId || undefined,
      jobId: jobId || undefined,
    },
    "manual",
  );

  if (appId) {
    sync.lastFinalizedAppIds = [appId];
  }
  sync.stateManager.save();

  if (!options?.skipPostSyncHooks) {
    await sync.runPostSyncHooks();
  }

  return result;
}

export async function pushAppNow(
  sync: CloudSyncHostService,
  appId: string,
): Promise<void> {
  const { getSyncCoordinator } = await import("./SyncCoordinator.js");
  const coordinator = getSyncCoordinator();
  if (coordinator) {
    await coordinator.flushNow(appId, { trigger: "manual" });
    return;
  }
  const { appNeedsOrderedFlushAsync } = await import("./pendingLocalUploads.js");
  if (
    !sync.getManualFlushError(appId) &&
    !(await appNeedsOrderedFlushAsync(sync, appId))
  ) {
    console.log(
      `[CloudSync] Manual upload skipped for ${appId} — already up to date`,
    );
    return;
  }
  const { flushAppNow } = await import("./flushAppNow.js");
  await flushAppNow(sync, appId, { skipTursoReschedule: true });
}

export function pushAppNowInBackground(sync: CloudSyncHostService, appId: string): void {
  void pushAppNow(sync, appId).catch((err: Error) => {
    console.warn(
      `[CloudSync] Background Upload now failed for ${appId}:`,
      err.message.slice(0, 160),
    );
  });
}

export async function prepareForComposerRun(
  sync: CloudSyncHostService,
  force = false,
): Promise<void> {
  const now = Date.now();
  const lastAt = composerPrepareAtByService.get(sync) ?? 0;
  if (!force && now - lastAt < COMPOSER_PREPARE_COOLDOWN_MS) {
    return;
  }
  composerPrepareAtByService.set(sync, now);

  if (!(await probeGitInstalled())) {
    return;
  }

  const token = await sync.ensureFreshToken();
  if (token && sync.tokenCache?.cloneUrl && hasWorkspaceGitAtRoot(sync.paprDir)) {
    await sync.updateRemoteUrl(buildAuthedUrl(sync.tokenCache.cloneUrl, token));
  }

  void pushNow(sync).catch((err: Error) => {
    console.warn(
      "[CloudSync] Composer background push failed:",
      err.message.slice(0, 120),
    );
  });
}
