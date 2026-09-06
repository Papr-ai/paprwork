/**
 * Sync V3 upload queue — apps via ordered flush, jobs via writer ops (no namespace git).
 */

import * as fs from "fs";
import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import { shouldAutoUploadApp, shouldAutoUploadRelativePath } from "../cloudUploadMode.js";
import { flushAutoUploadAppFolderIfNeeded } from "./flushQueuedAppFolder.js";
import type { QueueItem } from "./syncState.js";
import type { SyncStateManager } from "./syncState.js";
import { reconcilePathsIfGitClean } from "./gitPathReconcile.js";

const QUEUED_DIRS = ["Jobs"] as const;
const MAX_RETRY_FAILURES = 3;
const PUSH_RETRY_BASE_MS = 15_000;

export interface CloudSyncQueueHost {
  get sync(): CloudSyncService;
  get paprDir(): string;
  isStopped(): boolean;
  isWriteContextValid(context: string): boolean;
  getStateManager(): SyncStateManager;
  getQueue(): QueueItem[];
  setQueue(items: QueueItem[]): void;
  shiftQueue(): QueueItem | undefined;
  unshiftQueue(item: QueueItem): void;
  pushQueue(item: QueueItem): void;
  get queueLength(): number;
  getQueueTotal(): number;
  setQueueTotal(total: number): void;
  getQueuePausedUntilMs(): number;
  setQueuePausedUntilMs(untilMs: number): void;
  getQueueIntervalMs(): number;
  setQueueTimer(callback: () => void, delayMs: number): void;
  setSyncStatus(status: "idle" | "syncing" | "queuing" | "error"): void;
  setLastSyncAt(iso: string): void;
  setLastError(error: string | null): void;
  removePathsFromQueue(paths: readonly string[]): void;
  runGit(args: string[], opts?: { timeout?: number }): Promise<string>;
  runPostSyncHooks(): Promise<void>;
}

export async function reconcileAllGitCleanSubdirs(host: CloudSyncQueueHost): Promise<number> {
  let reconciled = 0;
  for (const parent of QUEUED_DIRS) {
    const parentPath = path.join(host.paprDir, parent);
    if (!fs.existsSync(parentPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = path.join(parent, entry.name);
      reconciled += (
        await reconcilePathsIfGitClean(
          host.paprDir,
          [relativePath],
          (args, opts) => host.runGit(args, opts),
          host.getStateManager(),
          (paths) => host.removePathsFromQueue(paths),
        )
      ).length;
    }
  }
  if (reconciled > 0) {
    console.log(
      `[CloudSync] Reconciled ${reconciled} git-clean app/job folder(s) after sync state reset`,
    );
  }
  return reconciled;
}

export async function enqueueAutoUploadApps(
  host: CloudSyncQueueHost,
  options?: { collectAppIdsForImmediateFlush?: string[] },
): Promise<void> {
  const appsPath = path.join(host.paprDir, "apps");
  if (!fs.existsSync(appsPath)) {
    return;
  }

  const stateManager = host.getStateManager();
  const relativePaths: string[] = [];
  for (const entry of fs.readdirSync(appsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    relativePaths.push(path.join("apps", entry.name));
  }

  if (relativePaths.length > 0) {
    await reconcilePathsIfGitClean(
      host.paprDir,
      relativePaths,
      (args, opts) => host.runGit(args, opts),
      stateManager,
      (paths) => host.removePathsFromQueue(paths),
    );
  }

  for (const relativePath of relativePaths) {
    const appId = path.basename(relativePath);
    if (stateManager.isDeadLetter(relativePath)) {
      continue;
    }

    if (!stateManager.hasItemChanged(relativePath)) {
      continue;
    }
    if (!shouldAutoUploadApp(appId, host.paprDir)) {
      continue;
    }

    if (options?.collectAppIdsForImmediateFlush) {
      options.collectAppIdsForImmediateFlush.push(appId);
      continue;
    }

    const { getSyncCoordinator } = await import("./SyncCoordinator.js");
    const coordinator = getSyncCoordinator();
    if (coordinator) {
      coordinator.scheduleAutoFlush(appId);
    }
  }
}

export async function enqueueSubDirs(host: CloudSyncQueueHost): Promise<void> {
  console.log("[CloudSync] V3 job enqueue scan (trigger=startup)");
  let skipped = 0;
  let deadLetterSkipped = 0;
  let reconciled = 0;
  const stateManager = host.getStateManager();
  const candidatePaths: string[] = [];

  for (const parent of QUEUED_DIRS) {
    const parentPath = path.join(host.paprDir, parent);
    if (!fs.existsSync(parentPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      candidatePaths.push(path.join(parent, entry.name));
    }
  }

  if (candidatePaths.length > 0) {
    reconciled = (
      await reconcilePathsIfGitClean(
        host.paprDir,
        candidatePaths,
        (args, opts) => host.runGit(args, opts),
        stateManager,
        (paths) => host.removePathsFromQueue(paths),
      )
    ).length;
  }

  for (const relativePath of candidatePaths) {
    if (stateManager.isDeadLetter(relativePath)) {
      deadLetterSkipped++;
      continue;
    }

    if (!stateManager.hasItemChanged(relativePath)) {
      skipped++;
      continue;
    }
    if (!shouldAutoUploadRelativePath(relativePath, host.paprDir)) {
      skipped++;
      continue;
    }

    host.pushQueue({ relativePath, failures: 0 });
  }

  host.setQueueTotal(host.queueLength);
  const queueTotal = host.getQueueTotal();
  if (queueTotal > 0 || skipped > 0 || deadLetterSkipped > 0) {
    const parts = [`queued ${queueTotal} changed`, `skipped ${skipped} unchanged`];
    if (deadLetterSkipped > 0) {
      parts.push(`${deadLetterSkipped} failed (dead-letter)`);
    }
    if (reconciled > 0) {
      parts.push(`reconciled ${reconciled}`);
    }
    console.log(`[CloudSync] Phase 2: ${parts.join(", ")}`);
  }
}

export function startQueueProcessor(host: CloudSyncQueueHost): void {
  if (host.queueLength === 0) {
    return;
  }
  processNextInQueue(host);
}

export function processNextInQueue(host: CloudSyncQueueHost): void {
  if (host.isStopped() || !host.isWriteContextValid("cloud sync queue")) {
    host.setQueue([]);
    return;
  }
  if (host.queueLength === 0) {
    void finishQueueProcessing(host).catch((err: Error) => {
      console.warn("[CloudSync] Queue finalize failed:", err.message.slice(0, 200));
      host.setLastError(err.message.slice(0, 200));
    });
    return;
  }

  const pausedUntil = host.getQueuePausedUntilMs();
  const delayMs =
    Date.now() < pausedUntil
      ? Math.max(host.getQueueIntervalMs(), pausedUntil - Date.now())
      : host.getQueueIntervalMs();

  host.setQueueTimer(() => {
    void processQueueItem(host);
  }, delayMs);
}

export async function processQueueItem(host: CloudSyncQueueHost): Promise<void> {
  if (host.isStopped() || !host.isWriteContextValid("cloud sync queue item")) {
    host.setQueue([]);
    return;
  }

  const { waitForWorkspaceReady } = await import("../workspaceReadiness.js");
  await waitForWorkspaceReady();
  if (host.isStopped() || !host.isWriteContextValid("cloud sync queue item")) {
    host.setQueue([]);
    return;
  }

  if (host.queueLength === 0) {
    processNextInQueue(host);
    return;
  }

  const nextItem = host.getQueue()[0];
  const normalizedPath = nextItem.relativePath.replace(/\\/g, "/");
  const appMatch = /^apps\/([^/]+)$/.exec(normalizedPath);
  if (appMatch && shouldAutoUploadApp(appMatch[1], host.paprDir)) {
    const queueItem = host.shiftQueue()!;
    host.setSyncStatus("queuing");

    try {
      const flushed = await flushAutoUploadAppFolderIfNeeded(
        host.sync,
        queueItem.relativePath,
        "auto",
      );
      if (flushed) {
        host.setLastSyncAt(new Date().toISOString());
        host.setLastError(null);
        console.log(
          `[CloudSync] Ordered flush ${queueItem.relativePath} — ${host.queueLength} remaining`,
        );
      } else {
        host.unshiftQueue(queueItem);
      }
    } catch (err) {
      handleQueueItemFailure(host, queueItem, err);
    }

    processNextInQueue(host);
    return;
  }

  const jobMatch = /^Jobs\/([^/]+)$/.exec(normalizedPath);
  if (jobMatch) {
    const queueItem = host.shiftQueue()!;
    host.setSyncStatus("queuing");

    try {
      const { pushWorkspaceV3Now } = await import("./pushV3Now.js");
      await pushWorkspaceV3Now(host.sync, { jobId: jobMatch[1] }, "auto");
      host.setLastSyncAt(new Date().toISOString());
      host.setLastError(null);
      console.log(
        `[CloudSync] V3 job flush ${queueItem.relativePath} — ${host.queueLength} remaining`,
      );
    } catch (err) {
      handleQueueItemFailure(host, queueItem, err);
    }

    processNextInQueue(host);
    return;
  }

  const orphanItem = host.shiftQueue();
  if (orphanItem) {
    console.warn(
      `[CloudSync] Dropping unhandled queue item ${orphanItem.relativePath} — namespace git push disabled`,
    );
    host.getStateManager().markSynced(orphanItem.relativePath);
    host.getStateManager().save();
  }
  processNextInQueue(host);
}

function handleQueueItemFailure(
  host: CloudSyncQueueHost,
  queueItem: QueueItem,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  queueItem.failures++;
  if (queueItem.failures >= MAX_RETRY_FAILURES) {
    host.getStateManager().recordDeadLetter(
      queueItem.relativePath,
      msg,
      queueItem.failures,
    );
    host.setLastError(msg.slice(0, 200));
  } else {
    host.unshiftQueue(queueItem);
    host.setQueuePausedUntilMs(Date.now() + PUSH_RETRY_BASE_MS);
  }
}

export async function finishQueueProcessing(
  host: CloudSyncQueueHost,
  skipPostSyncHooks?: boolean,
): Promise<void> {
  if (host.isStopped() || !host.isWriteContextValid("cloud sync finalize")) {
    console.warn(
      "[CloudSync] Skipping queue finalize — workspace switch or stale sync instance",
    );
    host.setQueue([]);
    return;
  }
  console.log("[CloudSync] Queue complete");
  host.setSyncStatus("idle");
  host.setLastSyncAt(new Date().toISOString());
  host.setLastError(null);
  if (!skipPostSyncHooks) {
    await host.runPostSyncHooks();
  }
}
