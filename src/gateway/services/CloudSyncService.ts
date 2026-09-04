/**
 * Cloud Sync Service — Sync V3 upload + legacy namespace git pull
 *
 * Upload (push): writer ops + workspace log via pushV3Now / SyncCoordinator.
 * No namespace monorepo git commit or push.
 *
 * Pull: ff-only namespace git for legacy read + Turso/workspace-log materialize.
 * Watch: one recursive OS watch (TreeWatcher) on workspace/ + data/ (hash-gated local sync state).
 * Queue: auto-upload apps and linked jobs via Sync V3 flush (no git push).
 */

import * as path from "path";
import * as fs from "fs";
import type { TreeWatcher } from "./TreeWatcher.js";
import { SyncStateManager, type QueueItem } from "./cloudSync/syncState.js";
import { buildGitHubSyncItemsReport } from "./cloudSync/syncItemStatus.js";
import { shouldAutoUploadRelativePath } from "./cloudUploadMode.js";
import { loadGitTrackedSubdirPaths } from "./cloudSync/gitPathStatus.js";
import { type GitRemoteReconcileResult } from "./cloudSync/namespaceGitReview.js";
import {
  applyGitRemoteUpdates as applyGitRemoteUpdatesFn,
  clearGitRemoteUpdateFlags as clearGitRemoteUpdateFlagsFn,
  tryAutoReconcileRemoteGit as tryAutoReconcileRemoteGitFn,
} from "./cloudSync/cloudSyncGitRemoteReview.js";
import {
  executeNamespaceGitPull,
  recoverUnpushedBacklogIfNeeded as recoverUnpushedBacklogFn,
} from "./cloudSync/cloudSyncGitPullExecution.js";
import {
  asHostService,
  createGitRemoteHost,
  createLifecycleHost,
  createPostHooksHost,
  createQueueHost,
  createTokenState,
  type CloudSyncHostService,
  type CloudSyncInternals,
} from "./cloudSync/cloudSyncHost.js";
import {
  prepareForComposerRun as prepareForComposerRunFn,
  pushAppDependentPathsNow as pushAppDependentPathsNowFn,
  pushAppNow as pushAppNowFn,
  pushAppNowInBackground as pushAppNowInBackgroundFn,
  pushGitNow as pushGitNowFn,
  pushNow as pushNowFn,
} from "./cloudSync/cloudSyncPushApi.js";
import { runPostSyncHooks as runPostSyncHooksFn } from "./cloudSync/cloudSyncPostHooks.js";
import {
  applyUserRepoToken as applyUserRepoTokenFn,
  buildAuthedUrl as buildAuthedUrlFn,
  callReposInit as callReposInitFn,
  ensureFreshToken as ensureFreshTokenFn,
  fetchRepoToken as fetchRepoTokenFn,
  getOriginRepoIdentity as getOriginRepoIdentityFn,
  normalizeRepoIdentity as normalizeRepoIdentityFn,
} from "./cloudSync/cloudSyncToken.js";
import type {
  CloudSyncPublicState,
  ManualFlushErrorRecord,
  PushGitScopedResult,
} from "./cloudSync/cloudSyncTypes.js";
export type { PushGitScopedResult } from "./cloudSync/cloudSyncTypes.js";
import { GitRunner, probeGitInstalled } from "./cloudSync/gitRunner.js";
import {
  runBackgroundInit as runBackgroundInitFn,
} from "./cloudSync/cloudSyncLifecycle.js";
import {
  getChangedInstantPaths as getChangedInstantPathsFn,
} from "./cloudSync/cloudSyncWorkspaceWatch.js";
import { reconcilePathsIfGitClean as reconcilePathsIfGitCleanFn } from "./cloudSync/gitPathReconcile.js";
import {
  countUnpushedCommits as countUnpushedCommitsFn,
  initialClone as initialCloneFn,
  pullTursoLinkedSourcesAfterGitPull as pullTursoAfterGitFn,
  shouldDeferGitPull as shouldDeferGitPullFn,
  updateRemoteUrl as updateRemoteUrlFn,
} from "./cloudSync/cloudSyncGitPull.js";
import {
  enqueueAutoUploadApps as enqueueAutoUploadAppsFn,
  enqueueSubDirs as enqueueSubDirsFn,
  finishQueueProcessing as finishQueueProcessingFn,
  reconcileAllGitCleanSubdirs as reconcileAllGitCleanSubdirsFn,
  startQueueProcessor as startQueueProcessorFn,
} from "./cloudSync/cloudSyncQueueProcessor.js";

import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
import { classifyRepoSize, measureGitDirBytes } from "./cloudSync/repoHygiene.js";

interface SyncState extends Omit<CloudSyncPublicState, "queueRemaining" | "queueTotal" | "manualFlushErrors"> {}

export class CloudSyncService implements CloudSyncInternals {
  watcher: TreeWatcher | null = null;
  pushTimer: ReturnType<typeof setTimeout> | null = null;
  queueTimer: ReturnType<typeof setTimeout> | null = null;
  pullTimer: ReturnType<typeof setTimeout> | null = null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  pullBackoffUntilMs = 0;
  consecutivePullFailures = 0;
  isSyncing = false;
  /** Serializes git mutations (queue processor vs manual app push). */
  private gitOpChain: Promise<void> = Promise.resolve();
  tokenCache: { token: string; expiresAt: Date; cloneUrl: string } | null = null;
  repoIdentityChanged = false;
  /** Prevents duplicate runBackgroundInit / heartbeat timers on repeated initialize(). */
  private backgroundInitStarted = false;
  /** Set on stop() — aborts in-flight queue processing and post-sync hooks. */
  stopped = false;
  /** Workspace this instance was created for (never follows getPaprRoot() mid-flight). */
  private readonly boundPaprDir: string;
  /** Generation when this instance was created — stale after workspace switch. */
  private readonly boundWriteGeneration: number;
  syncQueue: QueueItem[] = [];
  queueTotal = 0;
  stateManager: SyncStateManager;
  readonly gitRunner = new GitRunner();
  /** Throttle for maybeRunRepoHygiene(). 0 = run on first sync after launch. */
  lastHygieneAtMs = 0;

  get paprDir(): string {
    return this.boundPaprDir;
  }

  isWriteContextValid(context: string): boolean {
    if (this.stopped) {
      return false;
    }
    return canPerformWorkspaceWrite(
      this.boundWriteGeneration,
      this.paprDir,
      context,
    );
  }

  state: SyncState = {
    status: "idle",
    lastSyncAt: null,
    lastError: null,
    repoUrl: null,
    cloudPublishing: false,
    cloudPublishingAppIds: [],
    gitUpdatesAvailable: false,
    gitUpdatesSummary: null,
    gitRemoteChangedPaths: null,
    gitHistoryDiverged: false,
    gitLocalAheadCount: 0,
    gitRemoteBehindCount: 0,
  };

  /** Per-app errors from background Upload now. */
  private readonly manualFlushErrorMap = new Map<string, ManualFlushErrorRecord>();

  /** Apps touched by the latest Sync V3 flush — drives targeted auto-republish. */
  lastFinalizedAppIds: string[] = [];

  readonly pushDebounceMs: number;
  readonly queueIntervalMs: number;
  queuePausedUntilMs = 0;

  constructor(opts?: {
    pushDebounceMs?: number;
    queueIntervalMs?: number;
  }) {
    this.pushDebounceMs = opts?.pushDebounceMs ?? 15_000;
    this.queueIntervalMs = opts?.queueIntervalMs ?? 5_000;
    this.boundPaprDir = getPaprRoot();
    this.boundWriteGeneration = getWorkspaceWriteGeneration();
    this.stateManager = new SyncStateManager(this.boundPaprDir);
  }

  private get host(): CloudSyncHostService {
    return asHostService(this);
  }

  getState(): CloudSyncPublicState {
    return {
      ...this.state,
      queueRemaining: this.syncQueue.length,
      queueTotal: this.queueTotal,
      manualFlushErrors: Object.fromEntries(this.manualFlushErrorMap.entries()),
    };
  }

  isCloudPublishingForApp(appId: string): boolean {
    return this.state.cloudPublishingAppIds.includes(appId);
  }

  recordManualFlushError(
    appId: string,
    error: Error,
    meta?: Pick<ManualFlushErrorRecord, "kind" | "conflictPaths">,
  ): void {
    const message = error.message.slice(0, 500);
    const at = new Date().toISOString();
    this.manualFlushErrorMap.set(appId, {
      message,
      at,
      ...(meta?.kind ? { kind: meta.kind } : {}),
      ...(meta?.conflictPaths?.length ? { conflictPaths: meta.conflictPaths } : {}),
    });
    this.state.lastError = message;
    this.state.status = "error";
  }

  clearManualFlushError(appId: string): void {
    this.manualFlushErrorMap.delete(appId);
    if (this.manualFlushErrorMap.size === 0) {
      if (this.state.status === "error") {
        this.state.status = "idle";
      }
      this.state.lastError = null;
    }
  }

  getManualFlushError(appId: string): ManualFlushErrorRecord | null {
    return this.manualFlushErrorMap.get(appId) ?? null;
  }

  /** Pause Phase-2 push queue (e.g. after workspace switch while UI reconnects). */
  deferQueueProcessingUntil(untilMs: number): void {
    this.queuePausedUntilMs = Math.max(this.queuePausedUntilMs, untilMs);
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    const delaySec = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
    console.log(`[CloudSync] Push queue deferred for ${delaySec}s (workspace switch grace)`);
  }

  getGitHubSyncItemsReport() {
    const remotePaths =
      this.state.gitRemoteChangedPaths !== null
        ? new Set(this.state.gitRemoteChangedPaths)
        : undefined;
    return buildGitHubSyncItemsReport({
      paprDir: this.paprDir,
      syncedItems: this.stateManager.data.syncedItems,
      queuedPaths: this.syncQueue.map((item) => item.relativePath),
      hasItemChanged: (relativePath) => this.stateManager.hasItemChanged(relativePath),
      deadLetter: this.stateManager.data.deadLetter,
      trackedInGit: loadGitTrackedSubdirPaths(this.paprDir),
      gitUpdatesAvailable: this.state.gitUpdatesAvailable,
      gitUpdatesSummary: this.state.gitUpdatesSummary,
      gitRemoteChangedPaths: remotePaths,
      gitHistoryDiverged: this.state.gitHistoryDiverged,
      gitLocalAheadCount: this.state.gitLocalAheadCount,
      gitRemoteBehindCount: this.state.gitRemoteBehindCount,
      shouldAutoUploadPath: (relativePath) =>
        shouldAutoUploadRelativePath(relativePath, this.paprDir),
    });
  }

  /** Clear dead-letter and queue one folder for retry (Settings UI). */
  async retryDeadLetterItem(relativePath: string): Promise<boolean> {
    if (!this.stateManager.retryDeadLetter(relativePath)) {
      return false;
    }
    const fullPath = path.join(this.paprDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      return true;
    }
    this.syncQueue.push({ relativePath, failures: 0 });
    this.queueTotal = Math.max(this.queueTotal, this.syncQueue.length);
    if (this.state.status !== "queuing") {
      this.state.status = "queuing";
    }
    this.startQueueProcessor();
    return true;
  }

  /**
   * Mark app + dependent job folders as synced when they are already committed
   * and clean in git (fixes stale "pending" when sync state was never updated).
   */
  async reconcileAppDependentPaths(appId: string): Promise<number> {
    const { resolveAppDependentJobIds, jobRelativePath } = await import(
      "./cloudSync/resolveAppDependentJobs.js"
    );
    const relativePaths = resolveAppDependentJobIds(this.paprDir, appId).map(
      jobRelativePath,
    );
    const reconciled = await this.reconcilePathsIfGitClean(relativePaths);
    return reconciled.length;
  }

  runExclusiveGitOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitOpChain.then(fn);
    this.gitOpChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  removePathsFromQueue(relativePaths: readonly string[]): void {
    if (relativePaths.length === 0 || this.syncQueue.length === 0) {
      return;
    }
    const skip = new Set(relativePaths);
    const before = this.syncQueue.length;
    this.syncQueue = this.syncQueue.filter((item) => !skip.has(item.relativePath));
    const removed = before - this.syncQueue.length;
    if (removed > 0) {
      console.log(
        `[CloudSync] Removed ${removed} app-scoped item(s) from background queue`,
      );
    }
  }

  private async reconcilePathsIfGitClean(
    relativePaths: readonly string[],
  ): Promise<string[]> {
    return reconcilePathsIfGitCleanFn(
      this.paprDir,
      relativePaths,
      (args, opts) => this.git(args, opts),
      this.stateManager,
      (paths) => this.removePathsFromQueue(paths),
    );
  }

  /**
   * Prepare local workspace for a Composer run — sync only, no repo resolution.
   * Memory server owns GitHub repo readiness for Cursor cloud agents.
   * Debounced: at most once every 2 minutes unless force=true (first turn in chat).
   */
  async prepareForComposerRun(force = false): Promise<void> {
    return prepareForComposerRunFn(this.host, force);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.backgroundInitStarted) {
      console.log("[CloudSync] initialize() skipped — background init already started");
      return;
    }
    this.backgroundInitStarted = true;

    console.log("[CloudSync] Initializing (background)...");

    if (!(await probeGitInstalled())) {
      console.warn("[CloudSync] git not found — cloud sync disabled");
      return;
    }

    void runBackgroundInitFn(createLifecycleHost(this.host)).catch((err: Error) => {
      console.error("[CloudSync] Init failed:", err.message);
      this.state.status = "error";
      this.state.lastError = err.message;
    });
  }

  async stop(): Promise<void> {
    console.log("[CloudSync] Stopping...");
    this.stopped = true;
    this.syncQueue = [];
    this.queueTotal = 0;
    this.lastFinalizedAppIds = [];
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
    if (this.pullTimer) { clearTimeout(this.pullTimer); this.pullTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
    getSyncCoordinator()?.stop();
    this.stateManager.save();
    console.log("[CloudSync] Stopped");
  }

  async pushNow(): Promise<void> {
    return pushNowFn(this.host);
  }

  /** Push local changes via Sync V3 (writer ops + workspace log). No namespace git push. */
  async pushAppDependentPathsNow(appId: string): Promise<PushGitScopedResult> {
    return pushAppDependentPathsNowFn(this.host, appId);
  }

  async pushGitNow(options?: {
    appId?: string;
    jobId?: string;
    skipPostSyncHooks?: boolean;
  }): Promise<PushGitScopedResult> {
    return pushGitNowFn(this.host, options);
  }

  async pushAppNow(appId: string): Promise<void> {
    return pushAppNowFn(this.host, appId);
  }

  pushAppNowInBackground(appId: string): void {
    this.clearManualFlushError(appId);
    pushAppNowInBackgroundFn(this.host, appId);
  }

  /** Enqueue a changed job folder for Sync V3 flush (apps use writer ops directly). */
  enqueueRelativePath(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/");
    if (/^apps\/[^/]+/.test(normalized)) {
      return;
    }
    if (this.stateManager.isDeadLetter(normalized)) {
      return;
    }
    if (!this.stateManager.hasItemChanged(normalized)) {
      return;
    }
    if (!shouldAutoUploadRelativePath(normalized, this.paprDir)) {
      return;
    }
    if (this.syncQueue.some((item) => item.relativePath === normalized)) {
      return;
    }
    this.syncQueue.push({ relativePath: normalized, failures: 0 });
    this.queueTotal = Math.max(this.queueTotal, this.syncQueue.length);
    if (!this.queueTimer && this.syncQueue.length > 0) {
      this.startQueueProcessor();
    }
  }

  getSyncQueueSnapshot(): ReadonlyArray<{ relativePath: string; failures: number }> {
    return [...this.syncQueue];
  }

  getChangedInstantPathsForV3(): string[] {
    return getChangedInstantPathsFn(this.paprDir, this.stateManager);
  }

  hasRelativePathChanged(relativePath: string): boolean {
    return this.stateManager.hasItemChanged(relativePath);
  }

  markRelativePathSynced(relativePath: string): void {
    this.stateManager.markSynced(relativePath.replace(/\\/g, "/"));
    this.stateManager.save();
  }

  getPaprDir(): string {
    return this.paprDir;
  }

  runGit(args: string[], opts?: { timeout?: number }): Promise<string> {
    return this.git(args, opts);
  }

  markAppForPostFlushHooks(appId: string): void {
    this.lastFinalizedAppIds = [appId];
  }

  async runPostFlushHooks(options?: {
    skipTursoReschedule?: boolean;
  }): Promise<void> {
    await this.runPostSyncHooks(options);
  }

  // ── Token management ──────────────────────────────────────────────

  async callReposInit(): Promise<boolean> {
    return callReposInitFn(createTokenState(this.host));
  }

  async fetchRepoToken() {
    return fetchRepoTokenFn(createTokenState(this.host));
  }

  async ensureFreshToken(): Promise<string | null> {
    return ensureFreshTokenFn(createTokenState(this.host));
  }

  applyUserRepoToken(
    userRepo: { repoUrl: string; cloneUrl: string },
    token: string,
    expiresAt: string,
  ): void {
    applyUserRepoTokenFn(createTokenState(this.host), userRepo, token, expiresAt);
  }

  buildAuthedUrl(cloneUrl: string, token: string): string {
    return buildAuthedUrlFn(cloneUrl, token);
  }

  async getOriginRepoIdentity(): Promise<string | null> {
    return getOriginRepoIdentityFn((args, opts) => this.git(args, opts));
  }

  // ── Git primitives (async — never blocks the Gateway event loop) ─

  async git(args: string[], opts?: { timeout?: number }): Promise<string> {
    this.cleanStaleLock();
    return this.gitRunner.run(args, { cwd: this.paprDir, timeout: opts?.timeout });
  }

  private cleanStaleLock(): void {
    const lockPath = path.join(this.paprDir, ".git", "index.lock");
    if (!fs.existsSync(lockPath)) return;
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > 15_000) {
        fs.unlinkSync(lockPath);
        console.log(`[CloudSync] Removed stale index.lock (${Math.round((Date.now() - stat.mtimeMs) / 1000)}s old)`);
      }
    } catch { /* may already be gone */ }
  }

  // ── V3 upload queue ───────────────────────────────────────────────

  private async reconcileAllGitCleanSubdirs(): Promise<number> {
    return reconcileAllGitCleanSubdirsFn(createQueueHost(this.host));
  }

  async enqueueAutoUploadApps(options?: {
    collectAppIdsForImmediateFlush?: string[];
  }): Promise<void> {
    return enqueueAutoUploadAppsFn(createQueueHost(this.host), options);
  }

  async enqueueSubDirs(): Promise<void> {
    return enqueueSubDirsFn(createQueueHost(this.host));
  }

  startQueueProcessor(): void {
    startQueueProcessorFn(createQueueHost(this.host));
  }

  async finishQueueProcessing(skipPostSyncHooks?: boolean): Promise<void> {
    return finishQueueProcessingFn(createQueueHost(this.host), skipPostSyncHooks);
  }

  // ── Periodic pull + heartbeat (delegated) ─────────────────────────

  async recoverUnpushedBacklogIfNeeded(): Promise<void> {
    return recoverUnpushedBacklogFn({
      countUnpushedCommits: () => this.countUnpushedCommits(),
      runGit: (args, opts) => this.git(args, opts),
      invalidateAllSyncedItems: () => this.stateManager.invalidateAllSyncedItems(),
      saveSyncState: () => this.stateManager.save(),
      reconcileAllGitCleanSubdirs: () => this.reconcileAllGitCleanSubdirs(),
    });
  }

  async runPostSyncHooks(options?: {
    skipTursoReschedule?: boolean;
  }): Promise<void> {
    return runPostSyncHooksFn(createPostHooksHost(this.host), options);
  }

  async shouldDeferGitPull(): Promise<{ defer: boolean; reason?: string }> {
    return shouldDeferGitPullFn(this.paprDir, this.stateManager, (args, opts) =>
      this.git(args, opts),
    );
  }

  private async countUnpushedCommits(): Promise<number> {
    return countUnpushedCommitsFn((args, opts) => this.git(args, opts));
  }

  // ── Clone / remote / pull ─────────────────────────────────────────

  async initialClone(cloneUrl: string): Promise<void> {
    return initialCloneFn(this.paprDir, this.gitRunner, (args, opts) =>
      this.git(args, opts),
      cloneUrl,
    );
  }

  async updateRemoteUrl(cloneUrl: string): Promise<void> {
    return updateRemoteUrlFn(
      (args, opts) => this.git(args, opts),
      cloneUrl,
      normalizeRepoIdentityFn,
    );
  }

  async pullNow(): Promise<void> {
    return this.pull();
  }

  async pullTursoLinkedSourcesAfterGitPull(): Promise<void> {
    return pullTursoAfterGitFn();
  }

  async pull(): Promise<void> {
    return executeNamespaceGitPull(createGitRemoteHost(this.host));
  }

  /**
   * Auto-merge legacy cloud runtime metadata when remote is ahead (pre-V3 namespaces).
   * Job runtime is always off git — status writebacks are ignored; runtime
   * arrives via desktop heartbeat patches instead.
   */
  async tryAutoReconcileRemoteGit(): Promise<GitRemoteReconcileResult> {
    return tryAutoReconcileRemoteGitFn(createGitRemoteHost(this.host));
  }

  /** Owner accepted remote git changes — fast-forward merge into local. */
  async applyGitRemoteUpdates(): Promise<void> {
    return applyGitRemoteUpdatesFn(createGitRemoteHost(this.host));
  }

  /** Owner dismissed remote git updates — keep local history; clears updates_available flag. */
  dismissGitRemoteUpdates(): void {
    this.clearGitRemoteUpdateFlags();
  }

  clearGitRemoteUpdateFlags(): void {
    clearGitRemoteUpdateFlagsFn(createGitRemoteHost(this.host));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  async tryAutoPublishCloudLinks(
    syncedAppIds: readonly string[] = [],
  ): Promise<void> {
    try {
      const github = this.getGitHubSyncItemsReport();
      const { buildTursoSyncItemsReport } = await import("./tursoSyncStatus.js");
      const turso = await buildTursoSyncItemsReport(
        path.join(this.paprDir, "apps"),
      );
      const { getCloudAppPublishService } = await import(
        "./CloudAppPublishService.js"
      );
      await getCloudAppPublishService().tryAutoPublishSyncedApps(github, turso, {
        syncedAppIds,
        candidateScope: "flush",
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("404") || message.includes("Not Found")) {
        return;
      }
      console.warn(
        "[CloudSync] Auto cloud publish skipped:",
        message.slice(0, 120),
      );
    }
  }

  /** Throttled heartbeat job — prefs-only publish recovery + catalog drift. */
  async runBackgroundAutoPublishCatalogScan(): Promise<void> {
    try {
      const github = this.getGitHubSyncItemsReport();
      const { buildTursoSyncItemsReport } = await import("./tursoSyncStatus.js");
      const turso = await buildTursoSyncItemsReport(
        path.join(this.paprDir, "apps"),
      );
      const { getCloudAppPublishService } = await import(
        "./CloudAppPublishService.js"
      );
      await getCloudAppPublishService().tryAutoPublishSyncedApps(github, turso, {
        candidateScope: "catalog",
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("404") || message.includes("Not Found")) {
        return;
      }
      console.warn(
        "[CloudSync] Background catalog auto-publish skipped:",
        message.slice(0, 120),
      );
    }
  }

  /** Current `.git` size for Settings → Sync display. */
  getRepoSizeInfo(): { gitDirBytes: number; level: "ok" | "warn" | "critical" } {
    return classifyRepoSize(measureGitDirBytes(this.paprDir));
  }

  /** Whether the workspace/data tree watcher is still running. */
  hasActiveWatcher(): boolean {
    return this.watcher !== null;
  }
}

export {
  initializeCloudSyncService,
  getCloudSyncService,
  resetCloudSyncServiceForWorkspaceSwitch,
} from "./cloudSync/cloudSyncSingleton.js";
