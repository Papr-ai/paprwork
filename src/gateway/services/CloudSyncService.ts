/**
 * Cloud Sync Service — bidirectional git sync between ~/Papr and GitHub
 *
 * Strategy: incremental queue (same pattern as code indexing).
 *
 * Phase 1: workspace/ + data/ — commit + push only when content hash changed
 * Phase 2: apps/{id} and Jobs/{id} — one commit + push per folder; next item waits for push
 * Push gate: never create a new commit while unpushed commits exist on main
 * Watch:             chokidar on workspace/ + data/ only (no EMFILE)
 * Periodic pull:     every PULL_INTERVAL_MS to pick up changes from other devices
 *
 * Queue state is persisted to ~/Papr/.cloud-sync-state.json so restarts
 * only re-queue items that changed since last successful sync.
 *
 * The user never sees GitHub. Paprwork gateway manages everything
 * using short-lived GitHub App installation tokens from the memory server.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import chokidar, { type FSWatcher } from "chokidar";
import { SyncStateManager, STATE_FILENAME, type QueueItem } from "./cloudSync/syncState.js";
import { CLOUD_REPO_HEAD_RELATIVE_PATH } from "./cloudSync/cloudRepoHeadMarker.js";
import { buildGitHubSyncItemsReport } from "./cloudSync/syncItemStatus.js";
import { shouldAutoUploadRelativePath, shouldAutoUploadApp } from "./cloudUploadMode.js";
import { canReconcilePathAsSynced, loadGitTrackedSubdirPaths } from "./cloudSync/gitPathStatus.js";
import {
  mergeRemoteMainIntoLocal,
  type GitRemoteReconcileResult,
  classifyIncomingRemoteChanges,
  formatIncomingRemoteReviewBlockReason,
  inferGitRemoteReviewState,
  listIncomingRemoteChangedPaths,
  isNonRetryableCloudPushError,
} from "./cloudSync/gitRemoteReconcile.js";
import { applyPendingCloudRunPatches } from "./cloudSync/applyPendingCloudRunPatches.js";
import { isJobRuntimeOffGit } from "./jobs/jobRuntimeOffGit.js";
import { GitRunner, probeGitInstalled } from "./cloudSync/gitRunner.js";
import {
  describeOversizedSkip,
  isTooLargeForGitSync,
} from "./cloudSync/gitSyncLimits.js";
import {
  HYGIENE_INTERVAL_MS,
  classifyRepoSize,
  measureGitDirBytes,
  partitionStagePaths,
  REPO_SIZE_CRITICAL_BYTES,
} from "./cloudSync/repoHygiene.js";
import { runRepoMaintenance } from "./cloudSync/repoMaintenance.js";
import { cloudApiFetch, waitForPaprApiKey } from "../utils/cloudApiClient.js";
import type { DesktopHeartbeatResponse } from "../types/cloudRuntime.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
import { buildCloudReposRequestBody } from "../../core/utils/cloudReposScope.js";

const INSTANT_DIRS = ["workspace", "data"];
const QUEUED_DIRS = ["apps", "Jobs"];

const MAX_RETRY_FAILURES = 3;
const MAX_PUSH_RETRIES = 5;
const PUSH_RETRY_BASE_MS = 15_000;
const PULL_INTERVAL_MS = 5 * 60_000;
const DESKTOP_HEARTBEAT_INTERVAL_MS = 60_000;
/** Single-commit push — one app/job folder or workspace bundle. */
const PUSH_TIMEOUT_MS = 180_000;
/** Draining a multi-commit backlog (startup recovery only). */
const BACKLOG_PUSH_TIMEOUT_MS = 600_000;
/** Split mega-commits with more than this many files back into the per-item queue. */
const MEGA_COMMIT_FILE_THRESHOLD = 15;
const PAPR_SYNC_AUTHOR = "Paprwork Desktop <sync@papr.ai>";

const GITIGNORE_CONTENT = `# Runtime — rebuilt per environment
**/venv/
**/.venv/
**/node_modules/
**/__pycache__/
**/dist/
# Published mini-apps NEED dist in git — apps.papr.ai serves the bundled
# dist/app.js (built at publish time) instead of 20+ individual TS modules.
!apps/*/dist/
!apps/*/dist/**
**/.versions/

# SQLite — synced via Turso, not git
**/*.db
**/*.db-wal
**/*.db-shm
**/*.sqlite
**/*.sqlite3

# Backups — local disaster-recovery artifacts. These are snapshots of data that
# is already synced (Turso for SQLite, git for code), so committing them stores
# a second, uncompressible copy of everything. Keep them OUT of the sync tree.
**/*.bak
**/*.bak.*
backups/
**/backups/

# Archives — migration tarballs and exports are large, opaque, and regenerable
**/*.tgz
**/*.tar.gz
**/*.zip

# Audio / recordings — runtime blobs (not git). Store metadata in job data.db
# (Turso sync); large files belong in object storage (bucket), not GitHub.
**/*.wav
**/data/recordings/

# Backup / corrupt recovery artifacts — local only (Turso repair, index recovery)
**/*.bak
**/*.bak.*
**/*.backup.*
**/*.backup-*
**/*.sync-backup-*
**/*.corrupt-*
**/*corrupt-backup*

# Local sync state — never in git
data/.db-memory-sync-state.json
data/.turso-convergence-state.json

# Logs — ephemeral
**/logs/
**/*.log

# Secrets — never in git
.env
*.pem
*.key

# Large runtime artifacts
**/chrome-profile/

# OS files
**/.DS_Store

# Sync state (local only — machine-specific Turso cursors)
${STATE_FILENAME}
data/.turso-sync-state.json

# Job runtime — local + memory heartbeat only, never git
Jobs/*/job.runtime.json
data/job-runs.jsonl
`;

interface RepoTokenResponse {
  repos: Array<{ scope: string; repoUrl: string; cloneUrl: string }>;
  token: string;
  expiresAt: string;
}

type SyncStatus = "idle" | "syncing" | "queuing" | "error";

interface SyncState {
  status: SyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  repoUrl: string | null;
  queueRemaining: number;
  queueTotal: number;
  /** True while auto-republish runs after git push (publish catalog / share links). */
  cloudPublishing: boolean;
  /** App ids currently being republished (subset of cloudPublishing). */
  cloudPublishingAppIds: string[];
  /** Remote git has commits local lacks — owner must review before merge (§6). */
  gitUpdatesAvailable: boolean;
  gitUpdatesSummary: string | null;
  /** Paths changed on origin/main that local lacks (for per-folder updates_available). */
  gitRemoteChangedPaths: string[] | null;
  /** Per-app Upload now errors (background flush). */
  manualFlushErrors: Record<string, { message: string; at: string }>;
}

export interface PushGitScopedResult {
  pushedPaths: string[];
  skippedPaths: string[];
  scope: "workspace" | "app" | "job";
  appId?: string;
  jobId?: string;
}

export class CloudSyncService {
  private watcher: FSWatcher | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pullBackoffUntilMs = 0;
  private consecutivePullFailures = 0;
  private isSyncing = false;
  /** Serializes git mutations (queue processor vs manual app push). */
  private gitOpChain: Promise<void> = Promise.resolve();
  private tokenCache: { token: string; expiresAt: Date; cloneUrl: string } | null = null;
  private repoIdentityChanged = false;
  /** Prevents duplicate runBackgroundInit / heartbeat timers on repeated initialize(). */
  private backgroundInitStarted = false;
  /** Set on stop() — aborts in-flight queue processing and post-sync hooks. */
  private stopped = false;
  /** Workspace this instance was created for (never follows getPaprRoot() mid-flight). */
  private readonly boundPaprDir: string;
  /** Generation when this instance was created — stale after workspace switch. */
  private readonly boundWriteGeneration: number;
  private syncQueue: QueueItem[] = [];
  private queueTotal = 0;
  private stateManager: SyncStateManager;
  private readonly gitRunner = new GitRunner();
  /** Throttle for maybeRunRepoHygiene(). 0 = run on first sync after launch. */
  private lastHygieneAtMs = 0;

  private get paprDir(): string {
    return this.boundPaprDir;
  }

  private isWriteContextValid(context: string): boolean {
    if (this.stopped) {
      return false;
    }
    return canPerformWorkspaceWrite(
      this.boundWriteGeneration,
      this.paprDir,
      context,
    );
  }

  private state: SyncState = {
    status: "idle",
    lastSyncAt: null,
    lastError: null,
    repoUrl: null,
    queueRemaining: 0,
    queueTotal: 0,
    cloudPublishing: false,
    cloudPublishingAppIds: [],
    gitUpdatesAvailable: false,
    gitUpdatesSummary: null,
    gitRemoteChangedPaths: null,
    manualFlushErrors: {},
  };

  /** Per-app errors from background Upload now. */
  private readonly manualFlushErrorMap = new Map<
    string,
    { message: string; at: string }
  >();

  /** Apps touched by the latest git push — drives targeted auto-republish. */
  private lastFinalizedAppIds: string[] = [];

  private readonly pushDebounceMs: number;
  private readonly queueIntervalMs: number;
  private queuePausedUntilMs = 0;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  getState(): SyncState {
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

  recordManualFlushError(appId: string, error: Error): void {
    const message = error.message.slice(0, 500);
    const at = new Date().toISOString();
    this.manualFlushErrorMap.set(appId, { message, at });
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

  getManualFlushError(
    appId: string,
  ): { message: string; at: string } | null {
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
    const relativePaths = [
      path.join("apps", appId),
      ...resolveAppDependentJobIds(this.paprDir, appId).map(jobRelativePath),
    ];
    const reconciled = await this.reconcilePathsIfGitClean(relativePaths);
    return reconciled.length;
  }

  private runExclusiveGitOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitOpChain.then(fn);
    this.gitOpChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private removePathsFromQueue(relativePaths: readonly string[]): void {
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
    const reconciled: string[] = [];

    for (const relativePath of relativePaths) {
      const fullPath = path.join(this.paprDir, relativePath);
      const exists = fs.existsSync(fullPath);
      let porcelain = "";
      let trackedFiles = "";
      try {
        porcelain = exists
          ? await this.git(["status", "--porcelain", "--", relativePath])
          : "";
        trackedFiles = exists
          ? await this.git(["ls-files", "--", relativePath])
          : "";
      } catch {
        continue;
      }

      if (
        !canReconcilePathAsSynced({
          exists,
          porcelain,
          trackedFiles,
        })
      ) {
        continue;
      }

      const prev = this.stateManager.data.syncedItems[relativePath];
      if (!prev || this.stateManager.hasItemChanged(relativePath)) {
        this.stateManager.markSynced(relativePath);
        reconciled.push(relativePath);
      }
    }

    if (reconciled.length > 0) {
      this.removePathsFromQueue(reconciled);
      this.stateManager.save();
      console.log(
        `[CloudSync] Reconciled ${reconciled.length} path(s) already clean in git`,
      );
    }

    return reconciled;
  }

  private lastComposerPrepareAt = 0;
  private static readonly COMPOSER_PREPARE_COOLDOWN_MS = 120_000;

  /**
   * Prepare local workspace for a Composer run — sync only, no repo resolution.
   * Memory server owns GitHub repo readiness for Cursor cloud agents.
   * Debounced: at most once every 2 minutes unless force=true (first turn in chat).
   */
  async prepareForComposerRun(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      now - this.lastComposerPrepareAt <
        CloudSyncService.COMPOSER_PREPARE_COOLDOWN_MS
    ) {
      return;
    }
    this.lastComposerPrepareAt = now;

    if (!(await probeGitInstalled())) {
      return;
    }

    const token = await this.ensureFreshToken();
    if (token && this.tokenCache?.cloneUrl && this.hasWorkspaceGitAtRoot()) {
      await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
    }

    void this.pushNow().catch((err: Error) => {
      console.warn(
        "[CloudSync] Composer background push failed:",
        err.message.slice(0, 120),
      );
    });
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

    void this.runBackgroundInit().catch((err: Error) => {
      console.error("[CloudSync] Init failed:", err.message);
      this.state.status = "error";
      this.state.lastError = err.message;
    });
  }

  private async runBackgroundInit(): Promise<void> {
    const paprKey = await waitForPaprApiKey();
    if (!paprKey) {
      console.warn("[CloudSync] No PAPR_API_KEY — login with Papr first");
      this.state.status = "error";
      this.state.lastError = "PAPR_API_KEY not configured";
      return;
    }

    // Ensure GitHub repo exists before token fetch / first push
    await this.callReposInit();

    const tokenResp = await this.fetchRepoToken();
    if (!tokenResp) {
      console.warn("[CloudSync] No git token from memory server");
      this.state.status = "error";
      this.state.lastError = "Could not fetch cloud repo token";
      return;
    }

    const userRepo = tokenResp.repos.find((r) => r.scope === "user");
    if (!userRepo) {
      console.warn("[CloudSync] No user repo in token response");
      this.state.status = "error";
      this.state.lastError = "No user repo in token response";
      return;
    }

    this.applyUserRepoToken(userRepo, tokenResp.token, tokenResp.expiresAt);
    const targetIdentity = this.normalizeRepoIdentity(userRepo.cloneUrl);
    console.log(`[CloudSync] Papr cloud repo: ${targetIdentity}`);

    const cloneUrl = this.buildAuthedUrl(userRepo.cloneUrl, tokenResp.token);

    const foreignGitRoot = await this.getForeignGitRoot();
    if (foreignGitRoot) {
      console.warn(
        `[CloudSync] Ignoring parent git at ${foreignGitRoot} — workspace ${this.paprDir} needs its own cloud repo`,
      );
    }

    if (!this.hasWorkspaceGitAtRoot()) {
      await this.initialClone(cloneUrl);
    } else {
      const previousIdentity = await this.getOriginRepoIdentity();
      if (previousIdentity && previousIdentity !== targetIdentity) {
        this.repoIdentityChanged = true;
        this.stateManager.resetForNewRepo();
        console.log(
          `[CloudSync] Local origin differs (${previousIdentity} → ${targetIdentity}) — will publish local history`,
        );
      }
      await this.updateRemoteUrl(cloneUrl);
      if (!this.repoIdentityChanged) {
        await this.pull();
      }
    }

    this.stateManager.load();
    this.startWatcher();
    this.startPeriodicPull();
    this.startDesktopHeartbeat();

    this.state.status = "idle";
    console.log("[CloudSync] Ready — watching for changes (initial sync continues in background)");

    void this.runInitialSyncPipeline().catch((err: Error) => {
      console.warn("[CloudSync] Initial sync failed:", err.message.slice(0, 200));
      this.state.lastError = err.message.slice(0, 200);
    });
  }

  private async runInitialSyncPipeline(): Promise<void> {
    await this.recoverUnpushedBacklogIfNeeded();
    await this.ensureRemoteCaughtUp();

    const instantPaths = this.getChangedInstantPaths();
    if (instantPaths.length > 0) {
      await this.commitAndPushPaths(instantPaths, "cloud sync: workspace and data");
    }

    await this.enqueueSubDirs();
    if (this.syncQueue.length === 0) {
      await this.finishQueueProcessing();
    } else {
      this.startQueueProcessor();
    }
    this.state.lastSyncAt = new Date().toISOString();
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
    await this.pushGitNow();
    const bridge = (await import("./TursoSyncBridge.js")).getTursoSyncBridge();
    if (bridge) {
      await bridge.pushDirtyLinkedSources();
    }
  }

  /**
   * Push local folders to GitHub only (no Turso).
   * Scope: workspace (default), one app (+ dependent jobs), or one job folder.
   */
  async pushGitNow(options?: {
    appId?: string;
    jobId?: string;
    skipPostSyncHooks?: boolean;
  }): Promise<PushGitScopedResult> {
    if (this.stopped || !this.isWriteContextValid("pushGitNow")) {
      return { pushedPaths: [], skippedPaths: [], scope: "workspace" };
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    const appId = options?.appId?.trim();
    const jobId = options?.jobId?.trim();

    if (!appId && !jobId) {
      return this.pushGitNowWorkspace(options?.skipPostSyncHooks);
    }

    return this.runExclusiveGitOp(async () => {
      await this.ensureRemoteCaughtUp();

      if (appId) {
        const { resolveAppCloudSyncRelativePaths } = await import(
          "./cloudSync/resolveAppDependentJobs.js"
        );
        let relativePaths = resolveAppCloudSyncRelativePaths(this.paprDir, appId);
        if (jobId) {
          const jobPath = path.join("Jobs", jobId);
          const appPath = path.join("apps", appId);
          relativePaths = relativePaths.filter(
            (relativePath) =>
              relativePath === appPath ||
              relativePath === jobPath ||
              relativePath === path.join("data", "jobs.json"),
          );
        }

        this.removePathsFromQueue(relativePaths);
        const pushedPaths: string[] = [];
        const skippedPaths: string[] = [];

        for (const relativePath of relativePaths) {
          const fullPath = path.join(this.paprDir, relativePath);
          if (!fs.existsSync(fullPath)) {
            this.stateManager.markSynced(relativePath);
            skippedPaths.push(relativePath);
            continue;
          }
          if (!this.stateManager.hasItemChanged(relativePath)) {
            this.stateManager.markSynced(relativePath);
            skippedPaths.push(relativePath);
            continue;
          }
          await this.commitAndPushPaths(
            [relativePath],
            `app sync: ${appId}${jobId ? ` job ${jobId}` : ""} (${relativePath})`,
          );
          pushedPaths.push(relativePath);
        }

        await this.reconcilePathsIfGitClean(relativePaths);
        this.lastFinalizedAppIds = [appId];
        this.stateManager.save();
        if (!options?.skipPostSyncHooks) {
          await this.runPostSyncHooks();
        }

        return {
          pushedPaths,
          skippedPaths,
          scope: jobId ? "job" : "app",
          appId,
          ...(jobId ? { jobId } : {}),
        };
      }

      if (jobId) {
        const relativePaths = [
          path.join("Jobs", jobId),
          path.join("data", "jobs.json"),
        ];
        this.removePathsFromQueue(relativePaths);
        const pushedPaths: string[] = [];
        const skippedPaths: string[] = [];

        for (const relativePath of relativePaths) {
          const fullPath = path.join(this.paprDir, relativePath);
          if (!fs.existsSync(fullPath)) {
            this.stateManager.markSynced(relativePath);
            skippedPaths.push(relativePath);
            continue;
          }
          if (!this.stateManager.hasItemChanged(relativePath)) {
            this.stateManager.markSynced(relativePath);
            skippedPaths.push(relativePath);
            continue;
          }
          await this.commitAndPushPaths(
            [relativePath],
            `job sync: ${jobId} (${relativePath})`,
          );
          pushedPaths.push(relativePath);
        }

        await this.reconcilePathsIfGitClean(relativePaths);
        this.stateManager.save();

        return {
          pushedPaths,
          skippedPaths,
          scope: "job",
          jobId,
        };
      }

      return {
        pushedPaths: [],
        skippedPaths: [],
        scope: "workspace",
      };
    });
  }

  /**
   * Full workspace git push — apps use ordered flush outside the git lock
   * so Turso → git ordering is preserved (no deadlock with flushAppNow).
   */
  private async pushGitNowWorkspace(
    skipPostSyncHooks?: boolean,
  ): Promise<PushGitScopedResult> {
    const pushedPaths: string[] = [];

    await this.runExclusiveGitOp(async () => {
      await this.ensureRemoteCaughtUp();
      const instantPaths = this.getChangedInstantPaths();
      if (instantPaths.length > 0) {
        await this.commitAndPushPaths(
          instantPaths,
          "manual push: workspace and data",
        );
        pushedPaths.push(...instantPaths);
      }
    });

    const appsToFlush: string[] = [];
    await this.enqueueSubDirs({ collectAppIdsForImmediateFlush: appsToFlush });

    const { flushAutoUploadAppFolderIfNeeded, appsRelativePath } = await import(
      "./cloudSync/flushQueuedAppFolder.js"
    );

    for (const appId of appsToFlush) {
      const relativePath = appsRelativePath(appId);
      const flushed = await flushAutoUploadAppFolderIfNeeded(
        this,
        relativePath,
        "manual",
      );
      if (flushed) {
        pushedPaths.push(relativePath);
      }
    }

    await this.runExclusiveGitOp(async () => {
      await this.ensureRemoteCaughtUp();
      while (this.syncQueue.length > 0) {
        const item = this.syncQueue.shift()!;
        if (!fs.existsSync(path.join(this.paprDir, item.relativePath))) {
          this.stateManager.markSynced(item.relativePath);
          continue;
        }
        if (!this.stateManager.hasItemChanged(item.relativePath)) {
          this.stateManager.markSynced(item.relativePath);
          continue;
        }

        const flushed = await flushAutoUploadAppFolderIfNeeded(
          this,
          item.relativePath,
          "manual",
        );
        if (flushed) {
          pushedPaths.push(item.relativePath);
          continue;
        }

        await this.commitAndPushPaths(
          [item.relativePath],
          `cloud sync: ${item.relativePath}`,
        );
        pushedPaths.push(item.relativePath);
      }
      this.stateManager.save();
    });

    await this.runExclusiveGitOp(async () => {
      await this.finishQueueProcessing(skipPostSyncHooks);
    });

    return {
      pushedPaths,
      skippedPaths: [],
      scope: "workspace",
    };
  }

  /** Push one mini-app — ordered cross-layer flush via SyncCoordinator (Phase 4+5). */
  async pushAppNow(appId: string): Promise<void> {
    const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
    const coordinator = getSyncCoordinator();
    if (coordinator) {
      await coordinator.flushNow(appId, { trigger: "manual" });
      return;
    }
    const { flushAppNow } = await import("./cloudSync/flushAppNow.js");
    await flushAppNow(this, appId, { skipTursoReschedule: true });
  }

  /**
   * Non-blocking Upload now for UI — returns immediately; errors via manualFlushErrors.
   */
  pushAppNowInBackground(appId: string): void {
    this.clearManualFlushError(appId);
    void this.pushAppNow(appId).catch((err: Error) => {
      console.warn(
        `[CloudSync] Background Upload now failed for ${appId}:`,
        err.message.slice(0, 160),
      );
    });
  }

  /** Enqueue a changed app/job folder for legacy git-only sync. */
  enqueueRelativePath(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/");
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

  private async callReposInit(): Promise<boolean> {
    try {
      const resp = await cloudApiFetch("/v1/cloud/repos/init", {
        method: "POST",
        body: buildCloudReposRequestBody("user"),
        timeoutMs: 60_000,
      });
      if (!resp.ok) {
        console.warn("[CloudSync] repos/init failed:", resp.status);
        return false;
      }
      const data = (await resp.json()) as { repoUrl?: string };
      if (data.repoUrl) {
        this.state.repoUrl = data.repoUrl;
      }
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("AbortError") || msg.includes("aborted")) {
        console.warn("[CloudSync] repos/init timed out (non-fatal, will retry on next sync)");
      } else {
        console.warn("[CloudSync] repos/init error:", msg.slice(0, 100));
      }
      return false;
    }
  }

  private async fetchRepoToken(): Promise<RepoTokenResponse | null> {
    try {
      const resp = await cloudApiFetch("/v1/cloud/repos/token", {
        method: "POST",
        body: buildCloudReposRequestBody("user"),
        timeoutMs: 60_000,
      });
      if (resp.status === 401) return null;
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`repos/token ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as RepoTokenResponse;
      const userRepo = data.repos.find((r) => r.scope === "user") ?? data.repos[0];
      if (!userRepo?.cloneUrl) {
        throw new Error("repos/token missing user cloneUrl");
      }
      this.applyUserRepoToken(userRepo, data.token, data.expiresAt);
      return data;
    } catch (err) {
      console.error("[CloudSync] Token fetch failed:", (err as Error).message);
      return null;
    }
  }

  private async ensureFreshToken(): Promise<string | null> {
    const bufferMs = 5 * 60_000;
    if (this.tokenCache && this.tokenCache.expiresAt.getTime() - Date.now() > bufferMs) {
      return this.tokenCache.token;
    }
    const resp = await this.fetchRepoToken();
    return resp?.token ?? null;
  }

  private applyUserRepoToken(
    userRepo: { repoUrl: string; cloneUrl: string },
    token: string,
    expiresAt: string,
  ): void {
    this.state.repoUrl = userRepo.repoUrl;
    this.tokenCache = {
      token,
      expiresAt: new Date(expiresAt),
      cloneUrl: userRepo.cloneUrl,
    };
  }

  private hasWorkspaceGitAtRoot(): boolean {
    return fs.existsSync(path.join(this.paprDir, ".git"));
  }

  /** Parent git root when workspace has no local `.git` but inherits ancestor repo. */
  private async getForeignGitRoot(): Promise<string | null> {
    if (this.hasWorkspaceGitAtRoot()) {
      return null;
    }
    if (!(await this.gitRunner.isRepo(this.paprDir))) {
      return null;
    }
    try {
      const topLevel = (await this.git(["rev-parse", "--show-toplevel"])).trim();
      const resolved = path.resolve(topLevel);
      if (resolved !== path.resolve(this.paprDir)) {
        return resolved;
      }
    } catch {
      /* not in a git work tree */
    }
    return null;
  }

  private isRepoNotFoundError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("repository not found") || lower.includes("remote: not found");
  }

  /** Re-provision GitHub repo + refresh token after push/auth failures. */
  private async provisionCloudRepo(): Promise<void> {
    this.tokenCache = null;
    await this.callReposInit();
    const resp = await this.fetchRepoToken();
    if (!resp) {
      throw new Error("Could not refresh cloud repo token after repos/init");
    }
    const userRepo = resp.repos.find((r) => r.scope === "user");
    if (!userRepo?.cloneUrl) {
      throw new Error("No user repo in token response after repos/init");
    }
    this.applyUserRepoToken(userRepo, resp.token, resp.expiresAt);
    await this.updateRemoteUrl(this.buildAuthedUrl(userRepo.cloneUrl, resp.token));
  }

  private normalizeRepoIdentity(url: string): string {
    return url
      .replace(/x-access-token:[^@]+@/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  }

  private async getOriginRepoIdentity(): Promise<string | null> {
    try {
      const remote = await this.git(["remote", "get-url", "origin"]);
      return this.normalizeRepoIdentity(remote);
    } catch {
      return null;
    }
  }

  private buildAuthedUrl(cloneUrl: string, token: string): string {
    if (cloneUrl.includes("x-access-token:")) {
      return cloneUrl.replace(/x-access-token:[^@]+/, `x-access-token:${token}`);
    }
    return cloneUrl.replace("https://", `https://x-access-token:${token}@`);
  }

  // ── Git primitives (async — never blocks the Gateway event loop) ─

  private async git(args: string[], opts?: { timeout?: number }): Promise<string> {
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

  // ── Phase 1: workspace + data (hash-gated) ────────────────────────

  private getChangedInstantPaths(): string[] {
    this.ensureGitignore();
    const paths: string[] = [];
    for (const dir of INSTANT_DIRS) {
      if (!fs.existsSync(path.join(this.paprDir, dir))) {
        continue;
      }
      if (this.stateManager.hasItemChanged(dir)) {
        paths.push(dir);
      }
    }
    if (this.stateManager.hasItemChanged(".gitignore")) {
      paths.push(".gitignore");
    }
    return paths;
  }

  private async syncWorkspaceIfChanged(): Promise<boolean> {
    if (this.state.status === "queuing") {
      return false;
    }
    if (!shouldAutoUploadRelativePath("workspace", this.paprDir)) {
      return false;
    }
    if ((await this.countUnpushedCommits()) > 0) {
      return false;
    }

    const paths = this.getChangedInstantPaths();
    if (paths.length === 0) {
      return false;
    }

    console.log(
      `[CloudSync] Git workspace sync (trigger=watcher) paths=${paths.length}`,
    );
    return this.commitAndPushPaths(paths, "cloud sync: workspace change");
  }

  // ── Phase 2: queued sub-dirs ──────────────────────────────────────

  private async reconcileAllGitCleanSubdirs(): Promise<number> {
    let reconciled = 0;
    for (const parent of QUEUED_DIRS) {
      const parentPath = path.join(this.paprDir, parent);
      if (!fs.existsSync(parentPath)) {
        continue;
      }
      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const relativePath = path.join(parent, entry.name);
        reconciled += (await this.reconcilePathsIfGitClean([relativePath])).length;
      }
    }
    if (reconciled > 0) {
      console.log(
        `[CloudSync] Reconciled ${reconciled} git-clean app/job folder(s) after sync state reset`,
      );
    }
    return reconciled;
  }

  private async enqueueSubDirs(options?: {
    /** Manual workspace push: collect app IDs for immediate ordered flush */
    collectAppIdsForImmediateFlush?: string[];
  }): Promise<void> {
    console.log("[CloudSync] Git enqueue scan (trigger=startup)");
    let skipped = 0;
    let deadLetterSkipped = 0;
    let reconciled = 0;

    for (const parent of QUEUED_DIRS) {
      const parentPath = path.join(this.paprDir, parent);
      if (!fs.existsSync(parentPath)) continue;

      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const relativePath = path.join(parent, entry.name);
        if (this.stateManager.isDeadLetter(relativePath)) {
          deadLetterSkipped++;
          continue;
        }

        // Per-path reconcile — one dirty app must not block healing others.
        reconciled += (await this.reconcilePathsIfGitClean([relativePath])).length;

        if (!this.stateManager.hasItemChanged(relativePath)) {
          skipped++;
          continue;
        }
        if (!shouldAutoUploadRelativePath(relativePath, this.paprDir)) {
          skipped++;
          continue;
        }

        if (parent === "apps") {
          const appId = entry.name;
          if (shouldAutoUploadApp(appId, this.paprDir)) {
            if (options?.collectAppIdsForImmediateFlush) {
              options.collectAppIdsForImmediateFlush.push(appId);
              skipped++;
              continue;
            }
            const { getSyncCoordinator } = await import(
              "./cloudSync/SyncCoordinator.js"
            );
            const coordinator = getSyncCoordinator();
            if (coordinator) {
              coordinator.scheduleAutoFlush(appId);
              skipped++;
              continue;
            }
          }
        }

        this.syncQueue.push({ relativePath, failures: 0 });
      }
    }

    this.queueTotal = this.syncQueue.length;
    if (this.queueTotal > 0 || skipped > 0 || deadLetterSkipped > 0) {
      const parts = [`queued ${this.queueTotal} changed`, `skipped ${skipped} unchanged`];
      if (deadLetterSkipped > 0) {
        parts.push(`${deadLetterSkipped} failed (dead-letter)`);
      }
      if (reconciled > 0) {
        parts.push(`reconciled ${reconciled}`);
      }
      console.log(`[CloudSync] Phase 2: ${parts.join(", ")}`);
    }
  }

  private startQueueProcessor(): void {
    if (this.syncQueue.length === 0) return;
    this.processNextInQueue();
  }

  private processNextInQueue(): void {
    if (this.stopped || !this.isWriteContextValid("cloud sync queue")) {
      this.syncQueue = [];
      return;
    }
    if (this.syncQueue.length === 0) {
      void this.finishQueueProcessing().catch((err: Error) => {
        console.warn("[CloudSync] Queue finalize failed:", err.message.slice(0, 200));
        this.state.lastError = err.message.slice(0, 200);
      });
      return;
    }

    if (Date.now() < this.queuePausedUntilMs) {
      this.queueTimer = setTimeout(() => {
        void this.processQueueItem();
      }, Math.max(this.queueIntervalMs, this.queuePausedUntilMs - Date.now()));
      return;
    }

    this.queueTimer = setTimeout(() => {
      void this.processQueueItem();
    }, this.queueIntervalMs);
  }

  private async processQueueItem(): Promise<void> {
    if (this.stopped || !this.isWriteContextValid("cloud sync queue item")) {
      this.syncQueue = [];
      return;
    }
    if (this.syncQueue.length === 0) {
      this.processNextInQueue();
      return;
    }

    const nextItem = this.syncQueue[0];
    const normalizedPath = nextItem.relativePath.replace(/\\/g, "/");
    const { flushAutoUploadAppFolderIfNeeded } = await import(
      "./cloudSync/flushQueuedAppFolder.js"
    );
    const appMatch = /^apps\/([^/]+)$/.exec(normalizedPath);
    if (appMatch && shouldAutoUploadApp(appMatch[1], this.paprDir)) {
      const queueItem = this.syncQueue.shift()!;
      this.state.status = "queuing";

      try {
        const flushed = await flushAutoUploadAppFolderIfNeeded(
          this,
          queueItem.relativePath,
          "auto",
        );
        if (flushed) {
          this.state.lastSyncAt = new Date().toISOString();
          this.state.lastError = null;
          console.log(
            `[CloudSync] Ordered flush ${queueItem.relativePath} — ${this.syncQueue.length} remaining`,
          );
        } else {
          this.syncQueue.unshift(queueItem);
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        queueItem.failures++;
        if (queueItem.failures >= MAX_RETRY_FAILURES) {
          this.stateManager.recordDeadLetter(
            queueItem.relativePath,
            msg,
            queueItem.failures,
          );
          this.state.lastError = msg.slice(0, 200);
        } else {
          this.syncQueue.unshift(queueItem);
          this.queuePausedUntilMs = Date.now() + PUSH_RETRY_BASE_MS;
        }
      }

      this.processNextInQueue();
      return;
    }

    try {
      await this.runExclusiveGitOp(async () => {
        await this.ensureRemoteCaughtUp();

        if (this.syncQueue.length === 0) {
          return;
        }

        const queueItem = this.syncQueue.shift()!;
        this.state.status = "queuing";

        try {
          if (!fs.existsSync(path.join(this.paprDir, queueItem.relativePath))) {
            this.stateManager.markSynced(queueItem.relativePath);
            this.stateManager.save();
            return;
          }

          if (!this.stateManager.hasItemChanged(queueItem.relativePath)) {
            this.stateManager.markSynced(queueItem.relativePath);
            this.stateManager.save();
            return;
          }

          const pushed = await this.commitAndPushPaths(
            [queueItem.relativePath],
            `cloud sync: ${queueItem.relativePath}`,
          );

          if (pushed) {
            console.log(
              `[CloudSync] Pushed ${queueItem.relativePath} — ${this.syncQueue.length} remaining`,
            );
          }

          this.state.lastSyncAt = new Date().toISOString();
          this.state.lastError = null;
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          queueItem.failures++;

          if (queueItem.failures >= MAX_RETRY_FAILURES) {
            console.error(
              `[CloudSync] Dead-letter ${queueItem.relativePath} after ${MAX_RETRY_FAILURES} failures: ${msg.slice(0, 120)}`,
            );
            this.stateManager.recordDeadLetter(
              queueItem.relativePath,
              msg,
              queueItem.failures,
            );
            this.state.lastError = msg.slice(0, 200);
          } else {
            console.warn(
              `[CloudSync] Failed ${queueItem.relativePath} (${queueItem.failures}/${MAX_RETRY_FAILURES}): ${msg.slice(0, 120)}`,
            );
            this.syncQueue.unshift(queueItem);
            this.queuePausedUntilMs = Date.now() + PUSH_RETRY_BASE_MS;
          }
        }
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.state.lastError = msg.slice(0, 200);
      if (isNonRetryableCloudPushError(msg)) {
        console.warn(
          `[CloudSync] Push blocked — owner merge required: ${msg.slice(0, 120)}`,
        );
      } else {
        this.queuePausedUntilMs = Date.now() + PUSH_RETRY_BASE_MS * 2;
        console.warn(
          `[CloudSync] Push backlog blocked queue — retrying in ${PUSH_RETRY_BASE_MS * 2 / 1000}s: ${msg.slice(0, 80)}`,
        );
      }
    }

    this.processNextInQueue();
  }

  private async finishQueueProcessing(skipPostSyncHooks?: boolean): Promise<void> {
    if (this.stopped || !this.isWriteContextValid("cloud sync finalize")) {
      console.warn(
        "[CloudSync] Skipping queue finalize — workspace switch or stale sync instance",
      );
      this.syncQueue = [];
      return;
    }
    console.log("[CloudSync] Queue complete — syncing deletions...");
    this.state.status = "syncing";
    await this.ensureRemoteCaughtUp();
    await this.detectAndSyncDeletions();
    if (await this.hasStagedChanges()) {
      await this.commitAndPushStaged("cloud sync: deletions");
    }
    this.state.status = "idle";
    this.stateManager.markFullSyncComplete();
    this.stateManager.save();
    if (!skipPostSyncHooks) {
      await this.runPostSyncHooks();
    }
  }

  // ── Delete detection ──────────────────────────────────────────────

  private async detectAndSyncDeletions(): Promise<void> {
    const deleted = this.stateManager.getDeletedItems();
    if (deleted.length === 0) return;

    for (const relativePath of deleted) {
      try {
        await this.git(["rm", "-r", "--cached", "--ignore-unmatch", "--", relativePath]);
        this.stateManager.removeSyncedItem(relativePath);
      } catch (err) {
        console.warn(`[CloudSync] Failed to rm ${relativePath}:`, (err as Error).message.slice(0, 100));
      }
    }

    console.log(`[CloudSync] Removed ${deleted.length} deleted item(s)`);
    this.stateManager.save();
  }

  // ── Periodic pull ─────────────────────────────────────────────────

  private startPeriodicPull(): void {
    this.pullTimer = setInterval(async () => {
      if (this.isSyncing || this.state.status === "queuing") return;
      if (Date.now() < this.pullBackoffUntilMs) return;
      try {
        await this.tryAutoReconcileRemoteGit();
        if ((await this.countUnpushedCommits()) > 0) {
          return;
        }
        await this.pull();
      } catch (err) {
        console.warn("[CloudSync] Periodic pull failed:", (err as Error).message.slice(0, 100));
      }
      // Hygiene rides the pull tick: idle, serialized, and self-throttled to
      // HYGIENE_INTERVAL_MS so it never competes with a user-facing push.
      await this.maybeRunRepoHygiene();
    }, PULL_INTERVAL_MS) as ReturnType<typeof setTimeout>;

    console.log(`[CloudSync] Periodic pull every ${PULL_INTERVAL_MS / 60_000} min`);
  }

  /** Tell memory server the desktop gateway is awake (cloud scheduler defers). */
  private startDesktopHeartbeat(): void {
    if (this.heartbeatTimer) {
      console.warn(
        "[CloudSync] Desktop heartbeat already running — skipping duplicate timer",
      );
      return;
    }

    const ping = async (): Promise<void> => {
      try {
        const res = await cloudApiFetch("/v1/cloud/runtime/heartbeat", {
          method: "POST",
          body: {},
          timeoutMs: 15_000,
        });
        if (!res.ok) {
          console.warn(
            "[CloudSync] Desktop heartbeat failed:",
            res.status,
            (await res.text()).slice(0, 80),
          );
          return;
        }
        const body = (await res.json()) as DesktopHeartbeatResponse;
        await this.handlePendingCloudRuns(body);
        await this.handleSyncIndexReconcile();
        await this.handleTrackPullOnPublish();
        await this.handleConvergenceCheck();
      } catch (err) {
        console.warn(
          "[CloudSync] Desktop heartbeat error:",
          (err as Error).message.slice(0, 80),
        );
      }
    };

    void ping();
    this.heartbeatTimer = setInterval(() => {
      void ping();
    }, DESKTOP_HEARTBEAT_INTERVAL_MS) as ReturnType<typeof setTimeout>;

    console.log(
      `[CloudSync] Desktop heartbeat every ${DESKTOP_HEARTBEAT_INTERVAL_MS / 1000}s`,
    );
  }

  /** Pull git when cloud scheduler ran jobs while desktop was asleep. Turso via sync-index on heartbeat. */
  private async handlePendingCloudRuns(
    heartbeat: DesktopHeartbeatResponse,
  ): Promise<void> {
    const pending = heartbeat.pendingCloudRuns ?? [];
    if (pending.length === 0) {
      return;
    }

    const { isJobRuntimeOffGit } = await import("./jobs/jobRuntimeOffGit.js");
    if (isJobRuntimeOffGit()) {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      const { applied, needsGitFallback } = await applyPendingCloudRunPatches(
        pending,
        { jobsService },
      );

      if (applied > 0) {
        console.log(
          `[CloudSync] Applied ${applied} cloud job runtime patch(es) via heartbeat`,
        );
      }

      if (!needsGitFallback) {
        return;
      }

      console.warn(
        "[CloudSync] Cloud patch missing scheduleState.nextRunAt — falling back to git pull",
      );
    }

    console.log(
      `[CloudSync] ${pending.length} cloud job run(s) while away — syncing workspace`,
    );

    try {
      const reconciled = await this.tryAutoReconcileRemoteGit();
      if (reconciled === "merged") {
        console.log("[CloudSync] Integrated cloud job runtime metadata after wake");
        return;
      }
      await this.pullNow();
    } catch (err) {
      console.warn(
        "[CloudSync] Pull after cloud runs failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  /** Poll Turso sync-index DB on heartbeat. */
  private async handleSyncIndexReconcile(): Promise<void> {
    const { syncTursoFromSyncIndex } = await import("./TursoSyncBridge.js");

    try {
      const summary = await syncTursoFromSyncIndex();
      if (summary.pulled > 0 || summary.pushed > 0) {
        console.log(
          `[CloudSync] Turso sync-index reconcile: pulled=${summary.pulled} pushed=${summary.pushed}`,
        );
      }
    } catch (err) {
      console.warn(
        "[CloudSync] Turso sync-index reconcile failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  /** Auto-pull track-mode installs when publisher revision changes on apps.papr.ai. */
  private async handleTrackPullOnPublish(): Promise<void> {
    try {
      const { getCloudAppTrackSyncService } = await import(
        "./CloudAppTrackSyncService.js"
      );
      await getCloudAppTrackSyncService().pullTrackAppsOnPublish();
    } catch (err) {
      console.warn(
        "[CloudSync] Track pull-on-publish skipped:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  /** Periodic local↔Turso convergence hash check (Phase 4). */
  private async handleConvergenceCheck(): Promise<void> {
    try {
      const { runConvergenceCheckForAllLinkedSources } = await import(
        "./cloudSync/convergenceChecker.js"
      );
      await runConvergenceCheckForAllLinkedSources(this.paprDir);
    } catch (err) {
      console.warn(
        "[CloudSync] Convergence check skipped:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  /**
   * Never stack local commits — drain to GitHub before creating another commit.
   */
  private async ensureRemoteCaughtUp(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
      const unpushed = await this.countUnpushedCommits();
      if (unpushed === 0) {
        return;
      }

      const timeout =
        unpushed === 1 ? PUSH_TIMEOUT_MS : BACKLOG_PUSH_TIMEOUT_MS;
      console.log(
        `[CloudSync] Pushing ${unpushed} unpushed commit(s) to GitHub (attempt ${attempt}/${MAX_PUSH_RETRIES})...`,
      );

      try {
        await this.pushMainBranch(timeout);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (isNonRetryableCloudPushError(msg)) {
          throw err;
        }
        if (attempt >= MAX_PUSH_RETRIES) {
          throw err;
        }
        const delay = PUSH_RETRY_BASE_MS * attempt;
        console.warn(
          `[CloudSync] Push failed — retrying in ${Math.round(delay / 1000)}s: ${msg.slice(0, 80)}`,
        );
        await this.sleep(delay);
        continue;
      }

      if ((await this.countUnpushedCommits()) === 0) {
        this.state.lastError = null;
        return;
      }
    }
  }

  private markPathsSynced(paths: readonly string[]): void {
    for (const relativePath of paths) {
      this.stateManager.markSynced(relativePath);
    }
    this.removePathsFromQueue(paths);
    this.stateManager.save();
  }

  private isNothingToCommitError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("nothing to commit") || lower.includes("nothing added to commit");
  }

  private async recoverUnpushedBacklogIfNeeded(): Promise<void> {
    const unpushed = await this.countUnpushedCommits();
    if (unpushed === 0) {
      return;
    }

    // Single unpushed commit — drain via ensureRemoteCaughtUp() in the pipeline (no reset).
    if (unpushed === 1) {
      return;
    }

    let fileCount = 0;
    try {
      const stat = await this.git(["diff", "--shortstat", "origin/main..HEAD"]);
      const match = stat.match(/(\d+) files? changed/);
      fileCount = match ? parseInt(match[1], 10) : 0;
    } catch {
      fileCount = MEGA_COMMIT_FILE_THRESHOLD + 1;
    }

    if (fileCount <= MEGA_COMMIT_FILE_THRESHOLD) {
      return;
    }

    console.log(
      `[CloudSync] Recovering ${unpushed} unpushed commit(s) (${fileCount} files) — per-item upload`,
    );
    await this.git(["reset", "--mixed", "origin/main"]);
    this.stateManager.invalidateAllSyncedItems();
    this.stateManager.save();
    await this.reconcileAllGitCleanSubdirs();
  }

  private pathMatchesPrefix(filePath: string, prefix: string): boolean {
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }

  private async getStagedFilesUnder(paths: readonly string[]): Promise<string[]> {
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    if (!staged) {
      return [];
    }
    return staged
      .split("\n")
      .filter(Boolean)
      .filter((filePath) => paths.some((prefix) => this.pathMatchesPrefix(filePath, prefix)));
  }

  /**
   * Detect files staged for deletion (exist in index but not working tree).
   * Used as a safety check to prevent accidental mass deletions from uninitialized working tree.
   */
  private async detectStagedDeletions(): Promise<string[]> {
    try {
      // git diff --cached --diff-filter=D shows only deleted files
      const deleted = await this.git(["diff", "--cached", "--diff-filter=D", "--name-only"]);
      if (!deleted) {
        return [];
      }
      return deleted.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async amendRepoHeadMarkerIntoLatestCommit(): Promise<void> {
    try {
      const headSha = (await this.git(["rev-parse", "HEAD"])).trim();
      if (!/^[0-9a-f]{7,40}$/i.test(headSha)) {
        return;
      }

      const markerPath = path.join(this.paprDir, CLOUD_REPO_HEAD_RELATIVE_PATH);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });

      let existing = "";
      try {
        existing = fs.readFileSync(markerPath, "utf8").trim();
      } catch {
        /* first marker write */
      }
      if (existing === headSha) {
        return;
      }

      fs.writeFileSync(markerPath, `${headSha}\n`, "utf8");
      await this.git(["add", CLOUD_REPO_HEAD_RELATIVE_PATH]);
      const staged = await this.git(["diff", "--cached", "--name-only"]);
      if (!staged.includes(CLOUD_REPO_HEAD_RELATIVE_PATH)) {
        return;
      }

      await this.git(["commit", "--amend", "--no-edit"]);
    } catch (err) {
      console.warn(
        "[CloudSync] Repo head marker amend skipped:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  private async unstageOversizedFiles(): Promise<void> {
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    if (!staged) {
      return;
    }

    const oversized: string[] = [];
    for (const relativePath of staged.split("\n").filter(Boolean)) {
      const fullPath = path.join(this.paprDir, relativePath);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && isTooLargeForGitSync(stat.size)) {
          oversized.push(relativePath);
        }
      } catch {
        /* skip missing paths */
      }
    }

    if (oversized.length === 0) {
      return;
    }

    console.warn(`[CloudSync] ${describeOversizedSkip(oversized)}`);
    await this.git(["reset", "HEAD", "--", ...oversized]);
  }

  private async commitAndPushPaths(
    paths: readonly string[],
    label: string,
  ): Promise<boolean> {
    if (this.stopped || !this.isWriteContextValid(label)) {
      return false;
    }
    if (paths.length === 0) {
      return false;
    }

    const changedPaths = paths.filter((relativePath) =>
      this.stateManager.hasItemChanged(relativePath),
    );
    if (changedPaths.length === 0) {
      return false;
    }

    await this.ensureRemoteCaughtUp();

    const { prepareAppsForCloudGitSyncFromPaths, appIdsFromSyncRelativePaths } =
      await import("./cloudSync/prepareAppsForCloud.js");
    const preparedAppIds = await prepareAppsForCloudGitSyncFromPaths(
      this.paprDir,
      changedPaths,
    );

    const stagePaths = [
      ...changedPaths,
      ...appIdsFromSyncRelativePaths(changedPaths).map((appId) =>
        path.join("apps", appId),
      ),
    ];
    await this.stageFiltered(stagePaths);
    await this.unstageOversizedFiles();

    // SAFETY: Detect accidental mass deletions (e.g., empty workspace after clone)
    const deletedFiles = await this.detectStagedDeletions();
    if (deletedFiles.length > 5) {
      console.error(
        `[CloudSync] SAFETY BLOCK: Refusing to commit ${deletedFiles.length} file deletions. ` +
        `This may indicate an uninitialized working tree. First 5: ${deletedFiles.slice(0, 5).join(", ")}`,
      );
      await this.git(["reset", "HEAD", "--", ...stagePaths]);
      // Try to restore working tree from HEAD
      try {
        await this.git(["checkout", "HEAD", "--", "."]);
        console.log("[CloudSync] Restored working tree from HEAD to prevent data loss");
      } catch {
        /* empty repo or other issue */
      }
      return false;
    }

    const stagedFiles = await this.getStagedFilesUnder(changedPaths);
    if (stagedFiles.length === 0) {
      const reconciled = await this.reconcilePathsIfGitClean(changedPaths);
      return reconciled.length > 0;
    }

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    try {
      await this.git([
        "commit",
        "-m",
        `${label}: ${stagedFiles.length} file(s) — ${timestamp}`,
        "--author",
        PAPR_SYNC_AUTHOR,
        "--",
        ...changedPaths,
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (this.isNothingToCommitError(msg)) {
        return false;
      }
      throw err;
    }

    await this.amendRepoHeadMarkerIntoLatestCommit();

    await this.pushMainBranch(PUSH_TIMEOUT_MS);
    this.repoIdentityChanged = false;
    this.markPathsSynced(changedPaths);
    this.lastFinalizedAppIds = preparedAppIds;
    this.state.lastSyncAt = new Date().toISOString();
    this.state.lastError = null;
    return true;
  }

  private async commitAndPushStaged(label: string): Promise<boolean> {
    if (!(await this.hasStagedChanges())) {
      return false;
    }

    await this.ensureRemoteCaughtUp();

    const staged = await this.git(["diff", "--cached", "--name-only"]);
    const fileCount = staged.split("\n").filter(Boolean).length;
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    try {
      await this.git([
        "commit",
        "-m",
        `${label}: ${fileCount} file(s) — ${timestamp}`,
        "--author",
        PAPR_SYNC_AUTHOR,
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (this.isNothingToCommitError(msg)) {
        return false;
      }
      throw err;
    }

    await this.amendRepoHeadMarkerIntoLatestCommit();

    await this.pushMainBranch(PUSH_TIMEOUT_MS);
    this.repoIdentityChanged = false;
    this.state.lastSyncAt = new Date().toISOString();
    this.state.lastError = null;
    return true;
  }

  private async runPostSyncHooks(options?: {
    skipTursoReschedule?: boolean;
  }): Promise<void> {
    if (this.stopped || !this.isWriteContextValid("cloud sync post-hooks")) {
      console.warn(
        "[CloudSync] Skipping post-sync hooks — workspace switch or stale sync instance",
      );
      return;
    }
    const syncedAppIds = [...this.lastFinalizedAppIds];
    this.lastFinalizedAppIds = [];

    const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
    const coordinator = getSyncCoordinator();
    const skipTurso =
      options?.skipTursoReschedule === true ||
      (coordinator !== null &&
        syncedAppIds.length > 0 &&
        coordinator.shouldSkipTursoRescheduleForApps(syncedAppIds));

    if (!skipTurso) {
      void import("./tursoPushScheduler.js")
        .then(({ scheduleTursoPushAllLinked }) =>
          scheduleTursoPushAllLinked("post_git"),
        )
        .catch((err: Error) => {
          console.warn(
            "[CloudSync] Turso push after git sync failed:",
            err.message.slice(0, 120),
          );
        });
    } else if (coordinator) {
      for (const appId of syncedAppIds) {
        coordinator.consumeTursoFlushedForApp(appId);
      }
      console.log(
        `[CloudSync] Skipping post-git Turso reschedule (${syncedAppIds.length} app(s) already flushed)`,
      );
    }

    const { webReady } = await import("./cloudSync/webReady.js");
    const webReadyAppIds: string[] = [];
    for (const appId of syncedAppIds) {
      const ready = await webReady(appId, this.paprDir);
      if (ready.ready) {
        webReadyAppIds.push(appId);
      } else {
        console.warn(
          `[CloudSync] Skipping publish/notify for ${appId}: ${ready.reason ?? "not web-ready"}${ready.detail ? ` — ${ready.detail}` : ""}`,
        );
      }
    }

    this.state = {
      ...this.state,
      cloudPublishing: true,
      cloudPublishingAppIds: [...webReadyAppIds],
    };
    try {
      await this.tryAutoPublishCloudLinks(webReadyAppIds);
    } finally {
      this.state = {
        ...this.state,
        cloudPublishing: false,
        cloudPublishingAppIds: [],
      };
    }

    if (webReadyAppIds.length > 0) {
      void import("./cloudSync/notifySyncedAppRevisions.js")
        .then(({ notifySyncedAppRevisions }) =>
          notifySyncedAppRevisions(webReadyAppIds),
        )
        .catch((err: Error) => {
          console.warn(
            "[CloudSync] App revision notify skipped:",
            err.message.slice(0, 120),
          );
        });
    }
  }

  private async hasStagedChanges(): Promise<boolean> {
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    return staged.length > 0;
  }

  private async pushMainBranch(timeoutMs: number = PUSH_TIMEOUT_MS): Promise<void> {
    const token = await this.ensureFreshToken();
    if (!token) {
      throw new Error("No token for push");
    }
    if (this.tokenCache?.cloneUrl) {
      await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
    }

    const preReconcile = await this.tryAutoReconcileRemoteGitInternal();
    if (preReconcile === "requires_review") {
      throw new Error(
        "Remote git has newer commits — review updates before pushing local changes",
      );
    }

    const pushOpts = { timeout: timeoutMs };
    if (this.repoIdentityChanged) {
      console.warn(
        "[CloudSync] Publishing local main to new Papr org repo (replacing remote bootstrap history)",
      );
      await this.git(
        ["push", "--force", "-u", "origin", "main"],
        { timeout: BACKLOG_PUSH_TIMEOUT_MS },
      );
      return;
    }

    try {
      await this.git(["push", "-u", "origin", "main"], pushOpts);
      return;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);

      if (this.isRepoNotFoundError(msg)) {
        console.warn(
          "[CloudSync] Remote repo missing or inaccessible — provisioning via repos/init and retrying push",
        );
        await this.provisionCloudRepo();
        await this.git(["push", "-u", "origin", "main"], pushOpts);
        return;
      }

      const rejected =
        msg.includes("rejected") ||
        msg.includes("fetch first") ||
        msg.includes("non-fast-forward");

      if (rejected) {
        const reconciled = await this.tryAutoReconcileRemoteGitInternal();
        if (reconciled === "merged") {
          console.log(
            "[CloudSync] Auto-merged cloud runtime metadata — retrying push",
          );
          await this.git(["push", "-u", "origin", "main"], pushOpts);
          return;
        }

        console.warn(
          "[CloudSync] Push rejected — remote ahead; setting updates_available for owner review",
        );
        try {
          await this.refreshGitUpdatesAvailable();
        } catch (fetchErr) {
          console.warn(
            "[CloudSync] fetch after push rejection failed:",
            (fetchErr as Error).message.slice(0, 120),
          );
        }
        throw new Error(
          "Remote git has newer commits — review updates before pushing local changes",
        );
      }

      throw err;
    }
  }

  private async countUnpushedCommits(): Promise<number> {
    try {
      const count = await this.git(["rev-list", "--count", "origin/main..HEAD"]);
      return parseInt(count, 10) || 0;
    } catch {
      try {
        const count = await this.git(["rev-list", "--count", "HEAD"]);
        return parseInt(count, 10) || 0;
      } catch {
        return 0;
      }
    }
  }

  // ── Clone / remote / pull ─────────────────────────────────────────

  private async initialClone(cloneUrl: string): Promise<void> {
    console.log("[CloudSync] First sync — cloning repo...");
    const tempDir = path.join(os.tmpdir(), `papr-clone-${Date.now()}`);

    try {
      await this.gitRunner.clone(cloneUrl, tempDir);
      if (!fs.existsSync(path.join(this.paprDir, ".git"))) {
        fs.cpSync(path.join(tempDir, ".git"), path.join(this.paprDir, ".git"), { recursive: true });
      }
      fs.rmSync(tempDir, { recursive: true, force: true });

      // CRITICAL: Restore working tree from cloned HEAD to prevent accidental deletions.
      // Without this, the empty workspace scaffold would be committed as "delete all files"
      // because git sees files in HEAD but not in working tree as deletions.
      try {
        await this.git(["checkout", "HEAD", "--", "."]);
        console.log("[CloudSync] Restored working tree from cloned HEAD");
      } catch (checkoutErr) {
        // If checkout fails (e.g., empty repo), continue — no files to restore
        console.log(
          "[CloudSync] Working tree checkout skipped:",
          (checkoutErr as Error).message.slice(0, 100),
        );
      }
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async updateRemoteUrl(cloneUrl: string): Promise<void> {
    const identity = this.normalizeRepoIdentity(cloneUrl);
    console.log(`[CloudSync] origin → ${identity}`);
    try {
      await this.git(["remote", "set-url", "origin", cloneUrl]);
    } catch {
      try {
        await this.git(["remote", "add", "origin", cloneUrl]);
      } catch {
        /* remote already exists */
      }
    }
  }

  async pullNow(): Promise<void> {
    return this.pull();
  }

  /** Git pull + Turso pull into local linked DBs (workspace "get updates"). */
  private async pullTursoLinkedSourcesAfterGitPull(): Promise<void> {
    try {
      const { syncTursoAfterGitPull } = await import("./TursoSyncBridge.js");
      await syncTursoAfterGitPull();
    } catch (err) {
      console.warn(
        "[CloudSync] Turso pull after git pull failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  private async pull(): Promise<void> {
    console.log("[CloudSync] Pulling latest...");
    this.state.status = "syncing";

    const token = await this.ensureFreshToken();
    if (!token) { this.state.status = "idle"; return; }
    if (this.tokenCache?.cloneUrl) {
      await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
    }

    try {
      const preReconcile = await this.runExclusiveGitOp(async () =>
        this.tryAutoReconcileRemoteGitInternal(),
      );
      if (preReconcile === "requires_review") {
        const paths = await listIncomingRemoteChangedPaths((args, opts) =>
          this.git(args, opts),
        );
        const summary = await this.git([
          "log",
          "--oneline",
          "-30",
          "HEAD..origin/main",
        ]);
        console.warn(
          `[CloudSync] Pull blocked — ${formatIncomingRemoteReviewBlockReason(summary, paths)}; awaiting owner review (updates_available)`,
        );
        await this.refreshGitUpdatesAvailable();
        this.state.status = "idle";
        this.state.lastError = null;
        this.consecutivePullFailures = 0;
        this.pullBackoffUntilMs = 0;
        return;
      }
      if (preReconcile === "merged") {
        console.log("[CloudSync] Pull: pre-merged cloud runtime metadata");
      }

      const output = await this.git(["pull", "--rebase=false", "--ff-only", "origin", "main"]);
      const pullSummary = output.split("\n")[0] ?? "";
      console.log("[CloudSync] Pull:", pullSummary);
      this.state.status = "idle";
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;
      this.consecutivePullFailures = 0;
      this.pullBackoffUntilMs = 0;

      const pulledChanges = !pullSummary.includes("Already up to date");

      if (pulledChanges) {
        try {
          const { getAppService } = await import("./AppService.js");
          await getAppService().enforceAppOwnershipIndex();
        } catch (ownershipErr) {
          console.warn(
            "[CloudSync] Post-pull app ownership enforcement failed:",
            (ownershipErr as Error).message.slice(0, 120),
          );
        }

        try {
          const { finalizePortableCloudAppResources } = await import(
            "./cloudAppLinkedResourcesInstall.js"
          );
          await finalizePortableCloudAppResources();
        } catch (repairErr) {
          console.warn(
            "[CloudSync] Portable resource repair after pull failed:",
            (repairErr as Error).message.slice(0, 120),
          );
        }
      }

      await this.pullTursoLinkedSourcesAfterGitPull();
    } catch (err) {
      const msg = (err as Error).message;
      const normalized = msg.toLowerCase();
      if (msg.includes("Already up to date")) {
        this.state.status = "idle";
        this.consecutivePullFailures = 0;
        this.pullBackoffUntilMs = 0;
        await this.pullTursoLinkedSourcesAfterGitPull();
        return;
      }

      const diverged =
        normalized.includes("conflict") ||
        normalized.includes("diverging branches") ||
        normalized.includes("divergent branches") ||
        normalized.includes("not possible to fast-forward") ||
        normalized.includes("cannot fast-forward");
      if (diverged) {
        const reconciled = await this.runExclusiveGitOp(async () =>
          this.tryAutoReconcileRemoteGitInternal(),
        );
        if (reconciled === "merged") {
          console.log("[CloudSync] Pull: auto-merged cloud runtime metadata");
          this.state.status = "idle";
          this.state.lastSyncAt = new Date().toISOString();
          this.state.lastError = null;
          this.consecutivePullFailures = 0;
          this.pullBackoffUntilMs = 0;
          try {
            const { getAppService } = await import("./AppService.js");
            await getAppService().enforceAppOwnershipIndex();
          } catch {
            /* non-fatal */
          }
          await this.pullTursoLinkedSourcesAfterGitPull();
          return;
        }

        console.warn(
          "[CloudSync] Pull blocked — remote has code changes; awaiting owner review (updates_available)",
        );
        try {
          await this.refreshGitUpdatesAvailable();
          this.state.status = "idle";
          this.state.lastError = null;
          this.consecutivePullFailures = 0;
          this.pullBackoffUntilMs = 0;
          return;
        } catch (re) {
          console.error(
            "[CloudSync] Failed to detect remote updates:",
            (re as Error).message.slice(0, 200),
          );
        }
      }

      this.consecutivePullFailures += 1;
      const backoffMs = Math.min(
        10 * 60_000,
        30_000 * 2 ** (this.consecutivePullFailures - 1),
      );
      this.pullBackoffUntilMs = Date.now() + backoffMs;
      console.error(
        `[CloudSync] Pull failed; retrying in ${Math.ceil(backoffMs / 1_000)}s:`,
        msg.slice(0, 200),
      );
      this.state.status = "error";
      this.state.lastError = msg.slice(0, 200);
    }
  }

  /**
   * Auto-merge cloud runtime metadata when remote is ahead (legacy path).
   * When JOB_RUNTIME_OFF_GIT=1, job status writebacks are ignored — runtime
   * arrives via desktop heartbeat patches instead.
   */
  async tryAutoReconcileRemoteGit(): Promise<GitRemoteReconcileResult> {
    return this.runExclusiveGitOp(async () => {
      const token = await this.ensureFreshToken();
      if (!token) {
        return "merge_failed";
      }
      if (this.tokenCache?.cloneUrl) {
        await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
      }
      return this.tryAutoReconcileRemoteGitInternal();
    });
  }

  /** Caller must hold git lock (inside runExclusiveGitOp) or be pushMainBranch. */
  private async tryAutoReconcileRemoteGitInternal(): Promise<GitRemoteReconcileResult> {
    try {
      const classification = await classifyIncomingRemoteChanges((args, opts) =>
        this.git(args, opts),
      );
      if (classification === "not_needed") {
        // Check if remote is actually ahead — if so, merge the legacy commits
        // even though they're "not_needed" (ignorable) so git history is linear.
        const behindRaw = await this.git([
          "rev-list",
          "--count",
          "HEAD..origin/main",
        ]);
        const behindCount = parseInt(behindRaw.trim(), 10) || 0;
        if (behindCount > 0) {
          console.log(
            `[CloudSync] Auto-merging ${behindCount} legacy job status commit(s) to linearize history`,
          );
          await mergeRemoteMainIntoLocal((args, opts) => this.git(args, opts), {
            stashMessage: "cloud-sync-auto-reconcile-legacy",
          });
          this.state.gitUpdatesAvailable = false;
          this.state.gitUpdatesSummary = null;
          this.state.gitRemoteChangedPaths = null;
          this.state.lastSyncAt = new Date().toISOString();
          return "merged";
        }
        if (isJobRuntimeOffGit()) {
          this.state.gitUpdatesAvailable = false;
          this.state.gitUpdatesSummary = null;
          this.state.gitRemoteChangedPaths = null;
        }
        return "not_needed";
      }
      if (classification === "requires_review") {
        await this.refreshGitUpdatesAvailable();
        return "requires_review";
      }

      console.log(
        "[CloudSync] Auto-merging cloud runtime metadata (job status writebacks)",
      );
      await mergeRemoteMainIntoLocal((args, opts) => this.git(args, opts), {
        stashMessage: "cloud-sync-auto-reconcile",
      });

      this.state.gitUpdatesAvailable = false;
      this.state.gitUpdatesSummary = null;
      this.state.gitRemoteChangedPaths = null;
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;

      try {
        const { getAppService } = await import("./AppService.js");
        await getAppService().enforceAppOwnershipIndex();
      } catch {
        /* non-fatal */
      }

      await this.pullTursoLinkedSourcesAfterGitPull();
      console.log("[CloudSync] Auto-merged cloud runtime metadata");
      return "merged";
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn(
        "[CloudSync] Auto-reconcile failed:",
        errMsg.length > 300 ? errMsg.slice(0, 300) + "..." : errMsg,
      );
      try {
        await this.refreshGitUpdatesAvailable();
      } catch {
        /* non-fatal */
      }
      return "merge_failed";
    }
  }

  /** Owner accepted remote git changes — merge into local (§6). */
  async applyGitRemoteUpdates(): Promise<void> {
    return this.runExclusiveGitOp(async () => {
      const token = await this.ensureFreshToken();
      if (!token) {
        throw new Error("No token for git pull");
      }
      if (this.tokenCache?.cloneUrl) {
        await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
      }

      await this.git(["fetch", "origin", "main"]);
      const mergeResult = await mergeRemoteMainIntoLocal((args, opts) => this.git(args, opts), {
        stashMessage: "cloud-sync-apply-updates",
      });
      console.log(
        `[CloudSync] Merge prep: restored ${mergeResult.restoredMetadataPaths} metadata path(s), ` +
          `${mergeResult.restoredEphemeralPaths} ephemeral path(s), ` +
          `stashed ${mergeResult.stashedSourcePaths} source path(s)`,
      );

      this.state.gitUpdatesAvailable = false;
      this.state.gitUpdatesSummary = null;
      this.state.gitRemoteChangedPaths = null;
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;

      try {
        const { getAppService } = await import("./AppService.js");
        await getAppService().enforceAppOwnershipIndex();
      } catch {
        /* non-fatal */
      }

      await this.pullTursoLinkedSourcesAfterGitPull();
      console.log("[CloudSync] Applied remote git updates");
    });
  }

  /** Owner dismissed remote git updates — keep local history; clears updates_available flag. */
  dismissGitRemoteUpdates(): void {
    this.state.gitUpdatesAvailable = false;
    this.state.gitUpdatesSummary = null;
    this.state.gitRemoteChangedPaths = null;
  }

  private async refreshGitUpdatesAvailable(): Promise<void> {
    await this.git(["fetch", "origin", "main"]);
    const behindRaw = await this.git(["rev-list", "--count", "HEAD..origin/main"]);
    const behindCount = parseInt(behindRaw.trim(), 10) || 0;
    if (behindCount === 0) {
      this.state.gitUpdatesAvailable = false;
      this.state.gitUpdatesSummary = null;
      this.state.gitRemoteChangedPaths = null;
      return;
    }
    const paths = await listIncomingRemoteChangedPaths((args, opts) =>
      this.git(args, opts),
    );
    const summary = await this.git(["log", "--oneline", "-30", "HEAD..origin/main"]);
    const summaryTrimmed = summary.trim() || null;
    if (isJobRuntimeOffGit()) {
      const review = inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: paths,
        gitUpdatesSummary: summaryTrimmed,
      });
      if (!review.requiresReview) {
        this.state.gitUpdatesAvailable = false;
        this.state.gitUpdatesSummary = null;
        this.state.gitRemoteChangedPaths = null;
        return;
      }
    }
    this.state.gitUpdatesAvailable = true;
    this.state.gitUpdatesSummary = summaryTrimmed ?? `${behindCount} commit(s) on cloud`;
    this.state.gitRemoteChangedPaths = paths;
  }

  // ── File watcher (small dirs only) ────────────────────────────────

  private startWatcher(): void {
    const watchPaths = INSTANT_DIRS
      .map((d) => path.join(this.paprDir, d))
      .filter((p) => fs.existsSync(p));
    if (watchPaths.length === 0) return;

    console.log(`[CloudSync] Watching ${watchPaths.length} dirs (workspace, data)`);
    this.watcher = chokidar.watch(watchPaths, {
      ignored: ["**/.git/**", "**/*.db", "**/*.db-wal", "**/*.db-shm"],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    });

    const scheduleDebounce = () => {
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(async () => {
        try {
          await this.syncWorkspaceIfChanged();
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (this.isNothingToCommitError(msg)) {
            return;
          }
          console.warn("[CloudSync] Workspace sync deferred:", msg.slice(0, 120));
        }
      }, this.pushDebounceMs);
    };

    this.watcher
      .on("add", () => scheduleDebounce())
      .on("change", () => scheduleDebounce())
      .on("unlink", () => scheduleDebounce())
      .on("error", (err) => {
        if (!String(err).includes("EMFILE")) console.error("[CloudSync] Watcher error:", err);
      });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async tryAutoPublishCloudLinks(
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

  private ensureGitignore(): void {
    const gitignorePath = path.join(this.paprDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf-8");
      return;
    }
    const existing = fs.readFileSync(gitignorePath, "utf-8");
    const requiredRuntimeLines = [
      "# Job runtime — local + memory heartbeat only, never git",
      "Jobs/*/job.runtime.json",
      "data/job-runs.jsonl",
      "# Turso sync safety snapshots — local only",
      "**/*.sync-backup-*",
    ];
    const missingRuntime = requiredRuntimeLines.some(
      (line) => !line.startsWith("#") && !existing.includes(line),
    );
    if (!missingRuntime) {
      return;
    }
    const appendix = ["", ...requiredRuntimeLines, ""].join("\n");
    fs.writeFileSync(gitignorePath, `${existing.trimEnd()}\n${appendix}`, "utf-8");
  }

  // ── Repo hygiene ──────────────────────────────────────────────────

  /**
   * Stage paths after filtering out never-track and oversized files.
   *
   * `.gitignore` alone is NOT sufficient here: an explicit `git add -- <path>`
   * bypasses ignore rules for already-tracked files, which is how 47 SQLite
   * databases and 78 `.bak` blobs ended up in one user's history (253 GB).
   */
  private async stageFiltered(stagePaths: string[]): Promise<void> {
    const { allowed, rejected } = partitionStagePaths(this.paprDir, stagePaths);
    if (rejected.length > 0) {
      console.warn(
        `[CloudSync] Skipped ${rejected.length} path(s) from git: ` +
          rejected
            .slice(0, 5)
            .map((r) => `${r.path} (${r.reason})`)
            .join(", "),
      );
    }
    if (allowed.length === 0) return;
    await this.git(["add", "--", ...allowed]);
  }

  /**
   * Bounded git maintenance, throttled to HYGIENE_INTERVAL_MS.
   *
   * Sweeps orphaned repack temp files, untracks forbidden blobs, and prunes
   * unreachable objects. Never throws — hygiene failing must not break sync.
   */
  private async maybeRunRepoHygiene(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHygieneAtMs < HYGIENE_INTERVAL_MS) return;
    this.lastHygieneAtMs = now;

    try {
      const result = await runRepoMaintenance(this.gitRunner, this.paprDir);
      const freedGb = (
        (result.gitDirBytesBefore - result.gitDirBytesAfter) /
        1073741824
      ).toFixed(2);
      if (
        result.tmpPacksRemoved > 0 ||
        result.untrackedFiles > 0 ||
        result.level !== "ok"
      ) {
        console.log(
          `[CloudSync] Repo hygiene: removed ${result.tmpPacksRemoved} temp pack(s), ` +
            `untracked ${result.untrackedFiles} file(s), freed ${freedGb} GB, ` +
            `repo now ${(result.gitDirBytesAfter / 1073741824).toFixed(2)} GB (${result.level})`,
        );
      }
      if (result.level === "critical") {
        this.state.lastError =
          `Cloud Sync repo is ${(result.gitDirBytesAfter / 1073741824).toFixed(1)} GB — ` +
          `above the ${REPO_SIZE_CRITICAL_BYTES / 1073741824} GB limit. ` +
          `Large binaries are being skipped. Run repo cleanup from Settings → Sync.`;
      }
    } catch (err) {
      console.warn(
        "[CloudSync] Repo hygiene failed:",
        (err as Error).message.slice(0, 160),
      );
    }
  }

  /** Current `.git` size for Settings → Sync display. */
  getRepoSizeInfo(): { gitDirBytes: number; level: "ok" | "warn" | "critical" } {
    return classifyRepoSize(measureGitDirBytes(this.paprDir));
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let instance: CloudSyncService | null = null;

export function initializeCloudSyncService(opts?: {
  pushDebounceMs?: number;
  queueIntervalMs?: number;
}): CloudSyncService {
  if (instance) {
    console.warn(
      "[CloudSync] initializeCloudSyncService called while instance exists — stopping orphaned timers",
    );
    void instance.stop();
  }
  instance = new CloudSyncService(opts);
  void import("./cloudSync/SyncCoordinator.js").then(({ initializeSyncCoordinator }) => {
    initializeSyncCoordinator(instance!);
    console.log("[CloudSync] SyncCoordinator ready");
  });
  return instance;
}

export function getCloudSyncService(): CloudSyncService | null {
  return instance;
}

export async function resetCloudSyncServiceForWorkspaceSwitch(): Promise<void> {
  if (!instance) {
    return;
  }
  await instance.stop();
  instance = null;
  const { resetSyncCoordinatorForWorkspaceSwitch } = await import(
    "./cloudSync/SyncCoordinator.js"
  );
  await resetSyncCoordinatorForWorkspaceSwitch();
}
