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
import { canReconcilePathAsSynced } from "./cloudSync/gitPathStatus.js";
import { GitRunner, probeGitInstalled } from "./cloudSync/gitRunner.js";
import { cloudApiFetch, waitForPaprApiKey } from "../utils/cloudApiClient.js";
import type { DesktopHeartbeatResponse } from "../types/cloudRuntime.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
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

# Audio / recordings — runtime blobs (not git). Store metadata in job data.db
# (Turso sync); large files belong in object storage (bucket), not GitHub.
**/*.wav
**/data/recordings/

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

# Sync state (local only)
${STATE_FILENAME}
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
  private syncQueue: QueueItem[] = [];
  private queueTotal = 0;
  private stateManager: SyncStateManager;
  private readonly gitRunner = new GitRunner();

  private get paprDir(): string {
    return getPaprRoot();
  }

  private state: SyncState = {
    status: "idle",
    lastSyncAt: null,
    lastError: null,
    repoUrl: null,
    queueRemaining: 0,
    queueTotal: 0,
    cloudPublishing: false,
  };

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
    this.stateManager = new SyncStateManager(this.paprDir);
  }

  getState(): SyncState {
    return {
      ...this.state,
      queueRemaining: this.syncQueue.length,
      queueTotal: this.queueTotal,
    };
  }

  getGitHubSyncItemsReport() {
    return buildGitHubSyncItemsReport({
      paprDir: this.paprDir,
      syncedItems: this.stateManager.data.syncedItems,
      queuedPaths: this.syncQueue.map((item) => item.relativePath),
      hasItemChanged: (relativePath) => this.stateManager.hasItemChanged(relativePath),
      deadLetter: this.stateManager.data.deadLetter,
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
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
    if (this.pullTimer) { clearTimeout(this.pullTimer); this.pullTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    this.stateManager.save();
    console.log("[CloudSync] Stopped");
  }

  async pushNow(): Promise<void> {
    return this.runExclusiveGitOp(async () => {
      if (this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }
      await this.ensureRemoteCaughtUp();

      const instantPaths = this.getChangedInstantPaths();
      if (instantPaths.length > 0) {
        await this.commitAndPushPaths(instantPaths, "manual push: workspace and data");
      }

      await this.enqueueSubDirs();
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
        await this.commitAndPushPaths([item.relativePath], `cloud sync: ${item.relativePath}`);
      }
      this.stateManager.save();

      await this.finishQueueProcessing();
      const bridge = (await import("./TursoSyncBridge.js")).getTursoSyncBridge();
      if (bridge) {
        await bridge.pushDirtyLinkedSources();
      }
    });
  }

  /** Push one mini-app and its linked/dependent jobs immediately (skips global queue). */
  async pushAppNow(appId: string): Promise<void> {
    return this.runExclusiveGitOp(async () => {
      const { resolveAppDependentJobIds, jobRelativePath } = await import(
        "./cloudSync/resolveAppDependentJobs.js"
      );
      const relativePaths = [
        path.join("apps", appId),
        ...resolveAppDependentJobIds(this.paprDir, appId).map(jobRelativePath),
      ];

      if (this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }

      this.removePathsFromQueue(relativePaths);
      await this.ensureRemoteCaughtUp();

      const changedPaths = relativePaths.filter((relativePath) => {
        const fullPath = path.join(this.paprDir, relativePath);
        if (!fs.existsSync(fullPath)) {
          this.stateManager.markSynced(relativePath);
          return false;
        }
        return this.stateManager.hasItemChanged(relativePath);
      });

      if (changedPaths.length > 0) {
        await this.commitAndPushPaths(
          changedPaths,
          `app sync: ${appId} (${changedPaths.length} folder(s))`,
        );
      }

      await this.reconcilePathsIfGitClean(relativePaths);

      this.lastFinalizedAppIds = [appId];
      this.stateManager.save();
      await this.runPostSyncHooks();

      const bridge = (await import("./TursoSyncBridge.js")).getTursoSyncBridge();
      if (bridge) {
        await bridge.pushDirtyLinkedSources();
      }
    });
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
    if ((await this.countUnpushedCommits()) > 0) {
      return false;
    }

    const paths = this.getChangedInstantPaths();
    if (paths.length === 0) {
      return false;
    }

    return this.commitAndPushPaths(paths, "cloud sync: workspace change");
  }

  // ── Phase 2: queued sub-dirs ──────────────────────────────────────

  private async isGitCleanUnderQueuedRoots(): Promise<boolean> {
    try {
      const porcelain = await this.git(["status", "--porcelain", "--", "apps/", "Jobs/"]);
      return porcelain.trim().length === 0;
    } catch {
      return false;
    }
  }

  private async enqueueSubDirs(): Promise<void> {
    let skipped = 0;
    let deadLetterSkipped = 0;
    let reconciled = 0;

    const hasPriorFullSync = Boolean(this.stateManager.data.lastFullSyncAt);
    const gitClean =
      hasPriorFullSync && Object.keys(this.stateManager.data.syncedItems).length > 0
        ? await this.isGitCleanUnderQueuedRoots()
        : false;

    if (gitClean) {
      const knownPaths = Object.keys(this.stateManager.data.syncedItems).filter(
        (relativePath) =>
          relativePath.startsWith("apps/") || relativePath.startsWith("Jobs/"),
      );
      reconciled = (await this.reconcilePathsIfGitClean(knownPaths)).length;
    }

    for (const parent of QUEUED_DIRS) {
      const parentPath = path.join(this.paprDir, parent);
      if (!fs.existsSync(parentPath)) continue;

      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        const relativePath = path.join(parent, entry.name);
        if (this.stateManager.isDeadLetter(relativePath)) {
          deadLetterSkipped++;
          continue;
        }
        if (!this.stateManager.hasItemChanged(relativePath)) {
          skipped++;
          continue;
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
      if (gitClean && this.queueTotal === 0) {
        parts.unshift("git clean");
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
    if (this.syncQueue.length === 0) {
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
      this.queuePausedUntilMs = Date.now() + PUSH_RETRY_BASE_MS * 2;
      this.state.lastError = msg.slice(0, 200);
      console.warn(
        `[CloudSync] Push backlog blocked queue — retrying in ${PUSH_RETRY_BASE_MS * 2 / 1000}s: ${msg.slice(0, 80)}`,
      );
    }

    this.processNextInQueue();
  }

  private async finishQueueProcessing(): Promise<void> {
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
    await this.runPostSyncHooks();
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
      if ((await this.countUnpushedCommits()) > 0) return;
      try { await this.pull(); }
      catch (err) { console.warn("[CloudSync] Periodic pull failed:", (err as Error).message.slice(0, 100)); }
    }, PULL_INTERVAL_MS) as ReturnType<typeof setTimeout>;

    console.log(`[CloudSync] Periodic pull every ${PULL_INTERVAL_MS / 60_000} min`);
  }

  /** Tell memory server the desktop gateway is awake (cloud scheduler defers). */
  private startDesktopHeartbeat(): void {
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

  /** Pull git + Turso when cloud scheduler ran jobs while desktop was asleep. */
  private async handlePendingCloudRuns(
    heartbeat: DesktopHeartbeatResponse,
  ): Promise<void> {
    const pending = heartbeat.pendingCloudRuns ?? [];
    if (pending.length === 0) {
      return;
    }

    console.log(
      `[CloudSync] ${pending.length} cloud job run(s) while away — syncing workspace`,
    );

    try {
      await this.pullNow();
    } catch (err) {
      console.warn(
        "[CloudSync] Pull after cloud runs failed:",
        (err as Error).message.slice(0, 120),
      );
    }

    try {
      const { syncTursoAfterCloudRun } = await import("./TursoSyncBridge.js");
      await syncTursoAfterCloudRun();
    } catch (err) {
      console.warn(
        "[CloudSync] Turso pull after cloud runs failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  // ── Push gate + per-item commit ───────────────────────────────────

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

  private async commitAndPushPaths(
    paths: readonly string[],
    label: string,
  ): Promise<boolean> {
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
    await this.git(["add", "--", ...stagePaths]);
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

  private async runPostSyncHooks(): Promise<void> {
    void import("./tursoPushScheduler.js")
      .then(({ scheduleTursoPushAllLinked }) => scheduleTursoPushAllLinked())
      .catch((err: Error) => {
        console.warn(
          "[CloudSync] Turso push after git sync failed:",
          err.message.slice(0, 120),
        );
      });

    const syncedAppIds = [...this.lastFinalizedAppIds];
    this.lastFinalizedAppIds = [];

    this.state = { ...this.state, cloudPublishing: true };
    try {
      await this.tryAutoPublishCloudLinks(syncedAppIds);
    } finally {
      this.state = { ...this.state, cloudPublishing: false };
    }

    void import("./cloudSync/notifySyncedAppRevisions.js")
      .then(({ notifySyncedAppRevisions }) => notifySyncedAppRevisions(syncedAppIds))
      .catch((err: Error) => {
        console.warn(
          "[CloudSync] App revision notify skipped:",
          err.message.slice(0, 120),
        );
      });
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

      const shouldForce =
        msg.includes("rejected") ||
        msg.includes("fetch first") ||
        msg.includes("non-fast-forward");

      if (!shouldForce) {
        throw err;
      }

      console.warn(
        "[CloudSync] Standard push failed — force-with-lease on diverged Papr cloud repo",
      );
      await this.git(
        ["push", "--force-with-lease", "-u", "origin", "main"],
        pushOpts,
      );
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

  private async pull(): Promise<void> {
    console.log("[CloudSync] Pulling latest...");
    this.state.status = "syncing";

    const token = await this.ensureFreshToken();
    if (!token) { this.state.status = "idle"; return; }
    if (this.tokenCache?.cloneUrl) {
      await this.updateRemoteUrl(this.buildAuthedUrl(this.tokenCache.cloneUrl, token));
    }

    try {
      const output = await this.git(["pull", "--rebase=false", "--ff-only", "origin", "main"]);
      console.log("[CloudSync] Pull:", output.split("\n")[0]);
      this.state.status = "idle";
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;
      this.consecutivePullFailures = 0;
      this.pullBackoffUntilMs = 0;

      try {
        const { getAppService } = await import("./AppService.js");
        await getAppService().enforceAppOwnershipIndex();
      } catch (ownershipErr) {
        console.warn(
          "[CloudSync] Post-pull app ownership enforcement failed:",
          (ownershipErr as Error).message.slice(0, 120),
        );
      }
    } catch (err) {
      const msg = (err as Error).message;
      const normalized = msg.toLowerCase();
      if (msg.includes("Already up to date")) {
        this.state.status = "idle";
        this.consecutivePullFailures = 0;
        this.pullBackoffUntilMs = 0;
        return;
      }

      const diverged =
        normalized.includes("conflict") ||
        normalized.includes("diverging branches") ||
        normalized.includes("divergent branches") ||
        normalized.includes("not possible to fast-forward") ||
        normalized.includes("cannot fast-forward");
      if (diverged) {
        console.warn("[CloudSync] Pull conflict — using local-wins strategy");
        try {
          await this.resolveConflictsLocalWins();
          this.state.status = "idle";
          this.state.lastSyncAt = new Date().toISOString();
          this.state.lastError = null;
          this.consecutivePullFailures = 0;
          this.pullBackoffUntilMs = 0;
          return;
        } catch (re) {
          console.error("[CloudSync] Conflict resolution failed:", (re as Error).message.slice(0, 200));
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

  private async resolveConflictsLocalWins(): Promise<void> {
    const dirty = (await this.git(["status", "--porcelain"])).trim().length > 0;
    if (dirty) {
      await this.git([
        "stash",
        "push",
        "--include-untracked",
        "-m",
        "cloud-sync-conflict-resolution",
      ]);
    }

    await this.git(["fetch", "origin", "main"]);
    try {
      // Preserve both histories. On an actual content conflict, the desktop's
      // committed version wins while non-conflicting cloud changes are kept.
      await this.git(["merge", "--no-edit", "-X", "ours", "origin/main"]);
    } catch (mergeErr) {
      try { await this.git(["merge", "--abort"]); } catch { /* best effort */ }
      throw mergeErr;
    }

    if (dirty) {
      try {
        await this.git(["stash", "pop"]);
      } catch (stashErr) {
        try {
          // During stash application, "theirs" is the pre-merge local work.
          await this.git(["checkout", "--theirs", "."]);
          await this.git(["stash", "drop"]);
        } catch {
          throw stashErr;
        }
      }
    }

    console.log("[CloudSync] Diverged histories merged (local wins conflicts)");
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
    fs.writeFileSync(path.join(this.paprDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let instance: CloudSyncService | null = null;

export function initializeCloudSyncService(opts?: {
  pushDebounceMs?: number;
  queueIntervalMs?: number;
}): CloudSyncService {
  instance = new CloudSyncService(opts);
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
}
