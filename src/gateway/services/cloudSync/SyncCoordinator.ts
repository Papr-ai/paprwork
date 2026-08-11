/**
 * Central sync orchestrator (Phase 5).
 *
 * Routes dirty signals from watchers/jobs → debounced Turso push or ordered app flush.
 * Manual Upload now and auto-upload apps use flushAppNow (Turso → git → publish).
 * Namespace app flushes are serialized; manual uploads jump the queue.
 */

import * as fs from "fs";
import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import type { TursoPushTrigger } from "../tursoPushScheduler.js";
import { scheduleTursoPushForJob } from "../tursoPushScheduler.js";
import { shouldAutoUploadApp } from "../cloudUploadMode.js";
import {
  clearStaleDirtyFlagIfClean,
  hasUnpushedLocalDbChanges,
  listDbDirtySyncKeys,
  loadTursoSyncState,
  markDbDirty as persistDbDirty,
} from "../tursoSyncState.js";
import { localDbHasSyncableUserTables } from "../tursoSyncBridgeCore.js";
import type {
  CoordinatorFlushResult,
  FlushNowOptions,
  FlushTrigger,
  SyncCoordinatorStatus,
} from "./coordinatorTypes.js";
import {
  clearGatewaySyncBusy,
  markGatewaySyncBusy,
} from "./syncBusyState.js";
import {
  boostFlushQueueItemToManual,
  sortFlushQueue,
  type NamespaceFlushQueueItem,
} from "./namespaceFlushQueue.js";

/** Debounce for auto-upload app code changes (SYNC_CONTRACT §7.1). */
const APP_AUTO_FLUSH_DEBOUNCE_MS = 35_000;

/** Bounded auto-upload retries — stops until next manual upload or new dirty signal. */
const AUTO_FLUSH_MAX_RETRIES = 3;
const AUTO_FLUSH_RETRY_BASE_MS = 60_000;

interface AutoFlushRetryState {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FlushErrorState {
  message: string;
  at: string;
  retryPending: boolean;
}

function parseAppIdFromRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  const match = /^apps\/([^/]+)$/.exec(normalized);
  return match?.[1] ?? null;
}

export class SyncCoordinator {
  private readonly sync: CloudSyncService;
  private readonly activeFlushes = new Map<string, Promise<CoordinatorFlushResult>>();
  private readonly gitDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly tursoFlushedAppIds = new Set<string>();
  private readonly flushQueue: NamespaceFlushQueueItem[] = [];
  private readonly autoFlushRetry = new Map<string, AutoFlushRetryState>();
  private readonly flushErrors = new Map<string, FlushErrorState>();
  private flushProcessorRunning = false;
  private currentFlushAppId: string | null = null;
  private namespaceBusyStartedAt: number | null = null;
  private activeProgress: { appId: string; startedAt: number } | null = null;

  constructor(sync: CloudSyncService) {
    this.sync = sync;
  }

  /** O(1) dirty signal + debounced Turso push (replaces direct scheduler calls). */
  markDbDirty(
    syncKey: string,
    dbPath: string,
    trigger: TursoPushTrigger = "watcher",
  ): void {
    if (!localDbHasSyncableUserTables(dbPath)) {
      return;
    }
    const paprDir = this.sync.getPaprDir();
    const state = loadTursoSyncState(paprDir);
    if (!hasUnpushedLocalDbChanges(syncKey, dbPath, state)) {
      clearStaleDirtyFlagIfClean(syncKey, dbPath, paprDir);
      return;
    }
    persistDbDirty(syncKey, dbPath, paprDir);
    scheduleTursoPushForJob(syncKey, "normal", trigger);
  }

  /**
   * Git dirty for app folders: auto-upload → ordered debounced flush.
   * Jobs/other paths → legacy per-folder git queue.
   */
  markGitDirty(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/");
    const appId = parseAppIdFromRelativePath(normalized);
    if (appId && shouldAutoUploadApp(appId, this.sync.getPaprDir())) {
      this.scheduleAutoFlush(appId);
      return;
    }
    this.sync.enqueueRelativePath(normalized);
  }

  scheduleAutoFlush(appId: string): void {
    this.clearAutoFlushRetryTimer(appId);
    this.autoFlushRetry.delete(appId);

    const existing = this.gitDebounceTimers.get(appId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.gitDebounceTimers.delete(appId);
      void this.flushNow(appId, { trigger: "auto" }).catch(() => {
        /* Auto failures handled in processFlushQueue */
      });
    }, APP_AUTO_FLUSH_DEBOUNCE_MS);

    this.gitDebounceTimers.set(appId, timer);
  }

  /** Ordered cross-layer flush — coalesces concurrent calls per appId. */
  async flushNow(
    appId: string,
    options?: FlushNowOptions,
  ): Promise<CoordinatorFlushResult> {
    const trigger: FlushTrigger = options?.trigger ?? "manual";
    const inflight = this.activeFlushes.get(appId);
    if (inflight) {
      if (trigger === "manual") {
        boostFlushQueueItemToManual(this.flushQueue, appId);
        this.updateGatewayBusyState(trigger);
      }
      return inflight;
    }

    const debounceTimer = this.gitDebounceTimers.get(appId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.gitDebounceTimers.delete(appId);
    }

    if (trigger === "manual") {
      this.clearAutoFlushFailure(appId);
    }

    const promise = new Promise<CoordinatorFlushResult>((resolve, reject) => {
      this.flushQueue.push({
        appId,
        trigger,
        enqueuedAt: Date.now(),
        resolve: (value) => resolve(value as CoordinatorFlushResult),
        reject,
      });
      sortFlushQueue(this.flushQueue);
      this.updateGatewayBusyState(trigger);
      void this.processFlushQueue();
    });

    this.activeFlushes.set(appId, promise);
    promise.finally(() => {
      this.activeFlushes.delete(appId);
    });
    return promise;
  }

  private async processFlushQueue(): Promise<void> {
    if (this.flushProcessorRunning) {
      return;
    }
    this.flushProcessorRunning = true;

    while (this.flushQueue.length > 0) {
      const item = this.flushQueue.shift();
      if (!item) {
        break;
      }

      this.currentFlushAppId = item.appId;
      this.activeProgress = { appId: item.appId, startedAt: Date.now() };
      this.updateGatewayBusyState(item.trigger);

      console.log(
        `[SyncCoordinator] flushNow appId=${item.appId} trigger=${item.trigger}`,
      );

      try {
        const result = await this.executeFlush(item.appId);
        this.clearAutoFlushFailure(item.appId);
        item.resolve(result);
      } catch (err) {
        const error = err as Error;
        if (item.trigger === "auto") {
          this.handleAutoFlushFailure(item.appId, error);
          item.resolve({
            appId: item.appId,
            localMigrationsApplied: [],
            tursoPushed: false,
            webReady: false,
            published: false,
            webReadyReason: error.message.slice(0, 160),
          });
        } else {
          this.recordFlushError(item.appId, error, false);
          this.sync.recordManualFlushError(item.appId, error);
          item.reject(error);
        }
      } finally {
        this.currentFlushAppId = null;
        if (this.activeProgress?.appId === item.appId) {
          this.activeProgress = null;
        }
        this.updateGatewayBusyState();
      }
    }

    this.flushProcessorRunning = false;
    this.updateGatewayBusyState();
  }

  private async executeFlush(appId: string): Promise<CoordinatorFlushResult> {
    const { flushAppNow } = await import("./flushAppNow.js");
    const result = await flushAppNow(this.sync, appId, {
      skipTursoReschedule: true,
    });
    this.noteTursoFlushedForApp(appId);
    this.sync.clearManualFlushError(appId);
    return result;
  }

  private handleAutoFlushFailure(appId: string, error: Error): void {
    const state = this.autoFlushRetry.get(appId) ?? { attempts: 0, timer: null };
    state.attempts += 1;
    const exhausted = state.attempts >= AUTO_FLUSH_MAX_RETRIES;
    this.recordFlushError(appId, error, !exhausted);
    this.sync.recordManualFlushError(appId, error);

    if (exhausted) {
      console.warn(
        `[SyncCoordinator] Auto flush exhausted retries for ${appId}:`,
        error.message.slice(0, 160),
      );
      this.autoFlushRetry.set(appId, state);
      return;
    }

    const delayMs = AUTO_FLUSH_RETRY_BASE_MS * 2 ** (state.attempts - 1);
    console.warn(
      `[SyncCoordinator] Auto flush failed for ${appId} (attempt ${state.attempts}/${AUTO_FLUSH_MAX_RETRIES}), retry in ${Math.round(delayMs / 1000)}s:`,
      error.message.slice(0, 120),
    );

    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushNow(appId, { trigger: "auto" }).catch(() => {
        /* Auto failures handled in processFlushQueue */
      });
    }, delayMs);
    this.autoFlushRetry.set(appId, state);
  }

  private recordFlushError(
    appId: string,
    error: Error,
    retryPending: boolean,
  ): void {
    this.flushErrors.set(appId, {
      message: error.message.slice(0, 500),
      at: new Date().toISOString(),
      retryPending,
    });
  }

  private clearAutoFlushFailure(appId: string): void {
    this.clearAutoFlushRetryTimer(appId);
    this.autoFlushRetry.delete(appId);
    this.flushErrors.delete(appId);
  }

  private clearAutoFlushRetryTimer(appId: string): void {
    const state = this.autoFlushRetry.get(appId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private updateGatewayBusyState(trigger?: FlushTrigger): void {
    const paprDir = this.sync.getPaprDir();
    const queuedAppIds = this.flushQueue.map((item) => item.appId);
    const activeAppId = this.currentFlushAppId;

    if (activeAppId || queuedAppIds.length > 0) {
      if (this.namespaceBusyStartedAt === null) {
        this.namespaceBusyStartedAt = Date.now();
      }
      markGatewaySyncBusy(
        {
          appId: activeAppId ?? queuedAppIds[0] ?? "namespace",
          operation: "flush",
          startedAtMs: this.namespaceBusyStartedAt,
          trigger,
          queueDepth: queuedAppIds.length + (activeAppId ? 1 : 0),
          queuedAppIds,
        },
        paprDir,
      );
      return;
    }

    clearGatewaySyncBusy(paprDir);
    this.namespaceBusyStartedAt = null;
  }

  getFlushError(
    appId: string,
  ): { message: string; at: string; retryPending: boolean } | null {
    return this.flushErrors.get(appId) ?? null;
  }

  noteTursoFlushedForApp(appId: string): void {
    this.tursoFlushedAppIds.add(appId);
  }

  consumeTursoFlushedForApp(appId: string): boolean {
    if (!this.tursoFlushedAppIds.has(appId)) {
      return false;
    }
    this.tursoFlushedAppIds.delete(appId);
    return true;
  }

  shouldSkipTursoRescheduleForApps(appIds: readonly string[]): boolean {
    return (
      appIds.length > 0 &&
      appIds.every((appId) => this.tursoFlushedAppIds.has(appId))
    );
  }

  getStatus(appId?: string): SyncCoordinatorStatus {
    const paprDir = this.sync.getPaprDir();
    const dbDirtySyncKeys = listDbDirtySyncKeys(paprDir);
    const gitDirtyAppIds: string[] = [];

    const appsDir = path.join(paprDir, "apps");
    try {
      for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const relativePath = path.join("apps", entry.name);
        if (this.sync.hasRelativePathChanged(relativePath)) {
          gitDirtyAppIds.push(entry.name);
        }
      }
    } catch {
      /* apps dir missing */
    }

    let activeFlush: SyncCoordinatorStatus["activeFlush"] = null;
    if (this.activeProgress) {
      activeFlush = {
        appId: this.activeProgress.appId,
        layer: "publish",
        startedAt: this.activeProgress.startedAt,
        label: "Ordered flush in progress",
      };
    }

    if (appId && activeFlush && activeFlush.appId !== appId) {
      activeFlush = null;
    }

    const queuedFlushAppIds = this.flushQueue.map((item) => item.appId);
    const flushErrors = Object.fromEntries(this.flushErrors.entries());

    return {
      activeFlush,
      gitDirtyAppIds: appId
        ? gitDirtyAppIds.filter((id) => id === appId)
        : gitDirtyAppIds,
      dbDirtySyncKeys,
      inFlightAppIds: [
        ...new Set([
          ...this.activeFlushes.keys(),
          ...(this.currentFlushAppId ? [this.currentFlushAppId] : []),
        ]),
      ],
      queuedFlushAppIds: appId
        ? queuedFlushAppIds.filter((id) => id === appId)
        : queuedFlushAppIds,
      flushErrors: appId
        ? Object.fromEntries(
            Object.entries(flushErrors).filter(([id]) => id === appId),
          )
        : flushErrors,
    };
  }

  stop(): void {
    for (const timer of this.gitDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.gitDebounceTimers.clear();

    for (const state of this.autoFlushRetry.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.autoFlushRetry.clear();
    this.flushQueue.length = 0;
    clearGatewaySyncBusy(this.sync.getPaprDir());
    this.namespaceBusyStartedAt = null;
  }
}

let coordinatorInstance: SyncCoordinator | null = null;

export function initializeSyncCoordinator(sync: CloudSyncService): SyncCoordinator {
  if (coordinatorInstance) {
    coordinatorInstance.stop();
  }
  coordinatorInstance = new SyncCoordinator(sync);
  return coordinatorInstance;
}

export function getSyncCoordinator(): SyncCoordinator | null {
  return coordinatorInstance;
}

export async function resetSyncCoordinatorForWorkspaceSwitch(): Promise<void> {
  if (coordinatorInstance) {
    coordinatorInstance.stop();
    coordinatorInstance = null;
  }
}
