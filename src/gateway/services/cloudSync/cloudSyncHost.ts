/**
 * Host bridge factories — wire CloudSyncService internals to extracted modules.
 */

import type { TreeWatcher } from "../TreeWatcher.js";
import type { CloudSyncService } from "../CloudSyncService.js";
import type { CloudSyncGitRemoteHost } from "./cloudSyncGitRemoteReview.js";
import {
  enforceAppOwnershipAfterPull,
  finalizePortableResourcesAfterPull,
  reconcileJobsRegistryAfterPull,
  type CloudSyncPullHost,
} from "./cloudSyncGitPullExecution.js";
import {
  handleSyncIndexReconcile,
  handleTrackPullOnPublish,
} from "./cloudSyncHeartbeat.js";
import type { CloudSyncLifecycleHost } from "./cloudSyncLifecycle.js";
import { maybeRunRepoHygiene } from "./cloudSyncRepoHygieneTick.js";
import type { CloudSyncPostHooksHost } from "./cloudSyncPostHooks.js";
import type { CloudSyncQueueHost } from "./cloudSyncQueueProcessor.js";
import type { TokenStateCallbacks } from "./cloudSyncToken.js";
import {
  startDesktopHeartbeat,
  startPeriodicPull,
} from "./cloudSyncHeartbeat.js";
import { startWorkspaceWatcher } from "./cloudSyncWorkspaceWatch.js";
import type { CloudSyncWorkspaceWatchHost } from "./cloudSyncWorkspaceWatch.js";
import type { GitRunner } from "./gitRunner.js";
import type { QueueItem } from "./syncState.js";
import type { SyncStateManager } from "./syncState.js";
import type { SyncStatus } from "./cloudSyncTypes.js";

/** Internal surface used by host factories (structural — CloudSyncService satisfies this). */
export interface CloudSyncInternals {
  readonly paprDir: string;
  readonly pushDebounceMs: number;
  readonly queueIntervalMs: number;
  readonly gitRunner: GitRunner;
  stopped: boolean;
  isSyncing: boolean;
  pushTimer: ReturnType<typeof setTimeout> | null;
  queueTimer: ReturnType<typeof setTimeout> | null;
  pullTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  pullBackoffUntilMs: number;
  consecutivePullFailures: number;
  tokenCache: { token: string; expiresAt: Date; cloneUrl: string } | null;
  repoIdentityChanged: boolean;
  syncQueue: QueueItem[];
  queueTotal: number;
  queuePausedUntilMs: number;
  lastHygieneAtMs: number;
  lastFinalizedAppIds: string[];
  watcher: TreeWatcher | null;
  stateManager: SyncStateManager;
  state: {
    status: SyncStatus;
    lastSyncAt: string | null;
    lastError: string | null;
    repoUrl: string | null;
    cloudPublishing: boolean;
    cloudPublishingAppIds: string[];
    gitUpdatesAvailable: boolean;
    gitUpdatesSummary: string | null;
    gitRemoteChangedPaths: string[] | null;
    gitHistoryDiverged: boolean;
    gitLocalAheadCount: number;
    gitRemoteBehindCount: number;
  };
  isWriteContextValid(context: string): boolean;
  removePathsFromQueue(relativePaths: readonly string[]): void;
  git(args: string[], opts?: { timeout?: number }): Promise<string>;
  runPostSyncHooks(options?: { skipTursoReschedule?: boolean }): Promise<void>;
  runExclusiveGitOp<T>(fn: () => Promise<T>): Promise<T>;
  shouldDeferGitPull(): Promise<{ defer: boolean; reason?: string }>;
  ensureFreshToken(): Promise<string | null>;
  updateRemoteUrl(cloneUrl: string): Promise<void>;
  buildAuthedUrl(cloneUrl: string, token: string): string;
  pullTursoLinkedSourcesAfterGitPull(): Promise<void>;
  clearGitRemoteUpdateFlags(): void;
  callReposInit(): Promise<boolean>;
  fetchRepoToken(): Promise<{
    repos: Array<{ scope: string; repoUrl: string; cloneUrl: string }>;
    token: string;
    expiresAt: string;
  } | null>;
  applyUserRepoToken(
    userRepo: { repoUrl: string; cloneUrl: string },
    token: string,
    expiresAt: string,
  ): void;
  initialClone(cloneUrl: string): Promise<void>;
  getOriginRepoIdentity(): Promise<string | null>;
  pull(): Promise<void>;
  tryAutoReconcileRemoteGit(): Promise<unknown>;
  recoverUnpushedBacklogIfNeeded(): Promise<void>;
  enqueueSubDirs(): Promise<void>;
  enqueueAutoUploadApps(): Promise<void>;
  finishQueueProcessing(skipPostSyncHooks?: boolean): Promise<void>;
  startQueueProcessor(): void;
  tryAutoPublishCloudLinks(appIds: readonly string[]): Promise<void>;
}

export type CloudSyncHostService = CloudSyncService & CloudSyncInternals;

export function createQueueHost(service: CloudSyncHostService): CloudSyncQueueHost {
  return {
    get sync() {
      return service;
    },
    get paprDir() {
      return service.paprDir;
    },
    isStopped: () => service.stopped,
    isWriteContextValid: (context) => service.isWriteContextValid(context),
    getStateManager: () => service.stateManager,
    getQueue: () => service.syncQueue,
    setQueue: (items) => {
      service.syncQueue = items;
    },
    shiftQueue: () => service.syncQueue.shift(),
    unshiftQueue: (item) => {
      service.syncQueue.unshift(item);
    },
    pushQueue: (item) => {
      service.syncQueue.push(item);
    },
    get queueLength() {
      return service.syncQueue.length;
    },
    getQueueTotal: () => service.queueTotal,
    setQueueTotal: (total) => {
      service.queueTotal = total;
    },
    getQueuePausedUntilMs: () => service.queuePausedUntilMs,
    setQueuePausedUntilMs: (untilMs) => {
      service.queuePausedUntilMs = untilMs;
    },
    getQueueIntervalMs: () => service.queueIntervalMs,
    setQueueTimer: (callback, delayMs) => {
      if (service.queueTimer) {
        clearTimeout(service.queueTimer);
      }
      service.queueTimer = setTimeout(callback, delayMs);
    },
    setSyncStatus: (status) => {
      service.state.status = status;
    },
    setLastSyncAt: (iso) => {
      service.state.lastSyncAt = iso;
    },
    setLastError: (error) => {
      service.state.lastError = error;
    },
    removePathsFromQueue: (paths) => service.removePathsFromQueue(paths),
    runGit: (args, opts) => service.git(args, opts),
    runPostSyncHooks: () => service.runPostSyncHooks(),
  };
}

export function createTokenState(service: CloudSyncHostService): TokenStateCallbacks {
  return {
    getRepoUrl: () => service.state.repoUrl,
    setRepoUrl: (url) => {
      service.state.repoUrl = url;
    },
    getTokenCache: () => service.tokenCache,
    setTokenCache: (cache) => {
      service.tokenCache = cache;
    },
  };
}

export function createGitRemoteHost(service: CloudSyncHostService): CloudSyncPullHost {
  const base: CloudSyncGitRemoteHost = {
    runGit: (args, opts) => service.git(args, opts),
    shouldDeferGitPull: () => service.shouldDeferGitPull(),
    pullTursoLinkedSourcesAfterGitPull: () => service.pullTursoLinkedSourcesAfterGitPull(),
    ensureFreshToken: () => service.ensureFreshToken(),
    updateRemoteUrl: (cloneUrl) => service.updateRemoteUrl(cloneUrl),
    buildAuthedUrl: (cloneUrl, token) => service.buildAuthedUrl(cloneUrl, token),
    getTokenCloneUrl: () => service.tokenCache?.cloneUrl ?? null,
    getGitRemoteFlags: () => ({
      gitUpdatesAvailable: service.state.gitUpdatesAvailable,
      gitUpdatesSummary: service.state.gitUpdatesSummary,
      gitRemoteChangedPaths: service.state.gitRemoteChangedPaths,
      gitHistoryDiverged: service.state.gitHistoryDiverged,
      gitLocalAheadCount: service.state.gitLocalAheadCount,
      gitRemoteBehindCount: service.state.gitRemoteBehindCount,
    }),
    patchGitRemoteFlags: (patch) => {
      Object.assign(service.state, patch);
    },
    clearGitRemoteUpdateFlags: () => service.clearGitRemoteUpdateFlags(),
    setLastSyncAt: (iso) => {
      service.state.lastSyncAt = iso;
    },
    setLastError: (error) => {
      service.state.lastError = error;
    },
    runExclusiveGitOp: (fn) => service.runExclusiveGitOp(fn),
    enforceAppOwnershipAfterPull: () => enforceAppOwnershipAfterPull(),
  };
  return {
    ...base,
    setSyncStatus: (status: SyncStatus) => {
      service.state.status = status;
    },
    getPullBackoffUntilMs: () => service.pullBackoffUntilMs,
    setPullBackoffUntilMs: (untilMs: number) => {
      service.pullBackoffUntilMs = untilMs;
    },
    getConsecutivePullFailures: () => service.consecutivePullFailures,
    setConsecutivePullFailures: (count: number) => {
      service.consecutivePullFailures = count;
    },
    incrementConsecutivePullFailures: () => {
      service.consecutivePullFailures += 1;
      return service.consecutivePullFailures;
    },
    finalizePortableResourcesAfterPull: () => finalizePortableResourcesAfterPull(),
    reconcileJobsRegistryAfterPull: () => reconcileJobsRegistryAfterPull(),
    getPaprDir: () => service.paprDir,
    reconcileSubAgentsAfterPull: () =>
      import("./cloudSyncGitPullExecution.js").then((m) =>
        m.reconcileSubAgentsAfterPull(service.paprDir),
      ),
  };
}

export function createRepoHygieneHost(service: CloudSyncHostService) {
  return {
    getPaprDir: () => service.paprDir,
    getGitRunner: () => service.gitRunner,
    getLastHygieneAtMs: () => service.lastHygieneAtMs,
    setLastHygieneAtMs: (ms: number) => {
      service.lastHygieneAtMs = ms;
    },
    setLastError: (error: string | null) => {
      service.state.lastError = error;
    },
  };
}

export function createPeriodicHost(service: CloudSyncHostService) {
  return {
    get sync() {
      return service;
    },
    isSyncing: () => service.isSyncing,
    getSyncStatus: () => service.state.status,
    getPullBackoffUntilMs: () => service.pullBackoffUntilMs,
    shouldDeferGitPull: () => service.shouldDeferGitPull(),
    tryAutoReconcileRemoteGit: () => service.tryAutoReconcileRemoteGit(),
    pull: () => service.pull(),
    maybeRunRepoHygiene: () => maybeRunRepoHygiene(createRepoHygieneHost(service)),
    setPullTimer: (callback: () => void, intervalMs: number) => {
      service.pullTimer = setInterval(callback, intervalMs) as ReturnType<
        typeof setTimeout
      >;
    },
    getHeartbeatTimer: () => service.heartbeatTimer,
    setHeartbeatTimer: (timer: ReturnType<typeof setTimeout> | null) => {
      service.heartbeatTimer = timer;
    },
    handleSyncIndexReconcile: () => handleSyncIndexReconcile(),
    handleTrackPullOnPublish: () => handleTrackPullOnPublish(),
  };
}

export function createWorkspaceWatchHost(
  service: CloudSyncHostService,
): CloudSyncWorkspaceWatchHost {
  return {
    getPaprDir: () => service.paprDir,
    getPushDebounceMs: () => service.pushDebounceMs,
    getSyncStatus: () => service.state.status,
    getStateManager: () => service.stateManager,
    clearPushTimer: () => {
      if (service.pushTimer) {
        clearTimeout(service.pushTimer);
        service.pushTimer = null;
      }
    },
    schedulePushTimer: (callback, delayMs) => {
      service.pushTimer = setTimeout(callback, delayMs);
    },
    setWatcher: (watcher) => {
      service.watcher = watcher;
    },
  };
}

export function createLifecycleHost(service: CloudSyncHostService): CloudSyncLifecycleHost {
  return {
    getPaprDir: () => service.paprDir,
    getGitRunner: () => service.gitRunner,
    runGit: (args, opts) => service.git(args, opts),
    setSyncStatus: (status) => {
      service.state.status = status;
    },
    setLastError: (error) => {
      service.state.lastError = error;
    },
    setLastSyncAt: (iso) => {
      service.state.lastSyncAt = iso;
    },
    callReposInit: () => service.callReposInit(),
    fetchRepoToken: () => service.fetchRepoToken(),
    applyUserRepoToken: (userRepo, token, expiresAt) =>
      service.applyUserRepoToken(userRepo, token, expiresAt),
    initialClone: (cloneUrl) => service.initialClone(cloneUrl),
    updateRemoteUrl: (cloneUrl) => service.updateRemoteUrl(cloneUrl),
    getOriginRepoIdentity: () => service.getOriginRepoIdentity(),
    onRepoIdentityChanged: () => {
      service.repoIdentityChanged = true;
      service.stateManager.resetForNewRepo();
    },
    getRepoIdentityChanged: () => service.repoIdentityChanged,
    shouldDeferGitPull: () => service.shouldDeferGitPull(),
    pull: () => service.pull(),
    getStateManager: () => service.stateManager,
    startWorkspaceWatcher: () =>
      startWorkspaceWatcher(createWorkspaceWatchHost(service)),
    startPeriodicPull: () => startPeriodicPull(createPeriodicHost(service)),
    startDesktopHeartbeat: () => startDesktopHeartbeat(createPeriodicHost(service)),
    recoverUnpushedBacklogIfNeeded: () => service.recoverUnpushedBacklogIfNeeded(),
    enqueueSubDirs: () => service.enqueueSubDirs(),
    enqueueAutoUploadApps: () => service.enqueueAutoUploadApps(),
    getSyncQueueLength: () => service.syncQueue.length,
    finishQueueProcessing: () => service.finishQueueProcessing(),
    startQueueProcessor: () => service.startQueueProcessor(),
  };
}

export function createPostHooksHost(service: CloudSyncHostService): CloudSyncPostHooksHost {
  return {
    isStopped: () => service.stopped,
    isWriteContextValid: (context) => service.isWriteContextValid(context),
    consumeFinalizedAppIds: () => {
      const ids = [...service.lastFinalizedAppIds];
      service.lastFinalizedAppIds = [];
      return ids;
    },
    getPaprDir: () => service.paprDir,
    setCloudPublishing: (appIds) => {
      service.state.cloudPublishing = true;
      service.state.cloudPublishingAppIds = [...appIds];
    },
    clearCloudPublishing: () => {
      service.state.cloudPublishing = false;
      service.state.cloudPublishingAppIds = [];
    },
    tryAutoPublishCloudLinks: (appIds) => service.tryAutoPublishCloudLinks(appIds),
  };
}

/** Cast helper — host factories need internal fields. */
export function asHostService(service: CloudSyncService): CloudSyncHostService {
  return service as CloudSyncHostService;
}
