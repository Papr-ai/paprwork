/**
 * AppService - Mini-app management
 * Reference: Paprwork v1 appManager.js
 */

import { promises as fs } from "fs";
import chokidar, { type FSWatcher } from "chokidar";
import path from "path";
import { shouldIgnoreAppWatchPath } from "./appWatchIgnore.js";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { withFileEditLock } from "../../core/utils/fileEditLock.js";
import { buildMiniApp, type MiniAppBuildResult } from "../utils/miniAppBuild.js";
import {
  type AppDataSource,
  type AppDataSourceRole,
  type AppDataSourcesFile,
  buildAppDbTsContent,
  dbHasOnlyBaselineTables,
  parseDataSourcesFile,
  resolveDataSourcesForWorkspace,
  serializeDataSourcesFile,
} from "./appDataSources.js";
import {
  BACKEND_FOLDER,
  DEFAULT_BACKEND_MANIFEST,
  DEFAULT_BACKEND_PING_HANDLER,
  hasBackendFiles,
} from "../utils/appBackendScaffold.js";
import { writeCloudAppMetadataFile } from "./cloudAppMetadataFile.js";
import { writeAgentChatSidecar } from "./appAgentChatSidecar.js";
import {
  hydrateAppAgentChatFromDisk,
  resolveAppAgentChatConfig,
} from "./appAgentChat/appAgentChatPersistence.js";
import { parseCloudAppMetadataFile } from "../../core/utils/cloudAppMetadata.js";
import {
  getPaprAppsRoot,
  getPaprDataDir,
  getPaprJobsRoot,
  getPaprRoot,
} from "../../core/utils/paprRoot.js";
import { scanAppCodeForJobDatabaseReferences } from "./appCodeDataSourceDiscovery.js";
import {
  sanitizeMiniAppIcon,
  validateMiniAppIcon,
} from "../../core/utils/miniAppIconValidation.js";
import {
  isAppAwaitingAssignmentInWorkspace,
  isAppWorkspaceUnassigned,
  mergeAppWorkspaceFields,
  readActiveAppWorkspaceScope,
  readAppWorkspaceFieldsFromDisk,
  shouldShowAppInMyApps,
  withWorkspaceScope,
} from "../../core/utils/appWorkspaceScope.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import {
  fetchForeignPublisherAppIds,
  isAppOwnedByCurrentUser,
  readAppDiskOwnershipHints,
  resolveActiveNamespaceId,
  shouldIndexAppFolderForCurrentUser,
} from "./appOwnership.js";
import {
  copyAppToNamespace as copyAppToNamespaceCore,
  CopyAppError,
  type CopyAppToNamespaceResult,
} from "./copyAppToNamespace.js";
import {
  assignAppToWorkspace as assignAppToWorkspaceCore,
  AppWorkspaceAssignError,
  type AssignAppToWorkspaceResult,
} from "./appWorkspaceAssignment.js";

export { CopyAppError, type CopyAppToNamespaceResult, AppWorkspaceAssignError, type AssignAppToWorkspaceResult };

export type { AppDataSource, AppDataSourceRole, AppDataSourcesFile };

/** Written by rebuildIndexIfCorrupted when metadata.json was not read (legacy). */
export const RECOVERED_INDEX_DESCRIPTION = "Recovered app (index was corrupted)";

/** Bundled home dashboard — stable id across installs (see default-apps/home-dashboard/app-id.txt). */
export const DEFAULT_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

// ESM compatibility: get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MiniAppCloudLineage {
  mode: "fork" | "track";
  sourceAppId: string;
  sourceSlug: string;
  sourceNamespaceId: string;
  installedAt: string;
  lastSyncedAt?: string;
}

import type { AppAgentChatConfig } from "../../core/types/appAgentChat.js";

export interface MiniApp {
  id: string;
  title: string;
  description: string;
  type: "app";
  createdAt: string;
  updatedAt: string;
  icon?: string;
  favorite?: boolean;
  preview?: string;
  /** Lifecycle status for Apps tab filtering. Undefined = "active". */
  status?: "draft" | "active" | "archived";
  /** ISO timestamp of the last time the user opened this app. */
  lastOpenedAt?: string;
  /** Total number of times the user has opened this app. */
  openCount?: number;
  createdByAgentId?: string;
  createdByAgentName?: string;
  /** Set when app was installed from Papr Cloud (fork or track). */
  cloudLineage?: MiniAppCloudLineage;
  /** Papr user id that owns this local app copy (My Apps). */
  ownerUserId?: string;
  /** Org that owns this app in My Apps (required for legacy apps to appear). */
  organizationId?: string;
  /** Namespace that owns this app in My Apps (required for legacy apps to appear). */
  namespaceId?: string;
  /** Embedded sub-agent chat bubble (desktop + published web). */
  agentChat?: AppAgentChatConfig;
  /** Topic tags for Community / Team catalog cards (not API integrations). */
  tags?: string[];
}

export interface AppFile {
  filename: string;
  content: string;
}

export interface AppFileVersion {
  versionId: string;
  filename: string;
  timestamp: string;
  reason: string;
  preview: string;
}

export interface AppFileVersionFull extends AppFileVersion {
  content: string;
}

export interface ValidationIssue {
  file: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
  rule?: string;
}

export interface DeleteAppOptions {
  /** When true, unpublish from cloud before deleting local files. Required if app is live on apps.papr.ai. */
  unpublishFromCloud?: boolean;
}

export interface DeleteAppResult {
  deleted: boolean;
  unpublished?: boolean;
  requiresUnpublishConfirm?: boolean;
  shareUrl?: string | null;
  appTitle?: string;
}

export interface ValidationResult {
  appId: string;
  timestamp: string;
  valid: boolean;
  issues: ValidationIssue[];
  filesChecked: number;
}

let appServiceInstance: AppService | null = null;

export class AppService {
  private legacyAppsDir: string;
  private legacyAppsIndexPath: string;
  private apps: Map<string, MiniApp>;
  private initialized: boolean;
  private watchers: Map<string, FSWatcher>;
  private debounceTimers: Map<string, NodeJS.Timeout>;
  private reloadBroadcastTimers: Map<string, NodeJS.Timeout>;
  private buildInFlight: Map<string, Promise<MiniAppBuildResult>>;
  private pendingDefaultJobs: Array<{ sourceDir: string; targetDir: string; appId: string }>;
  private lastBuildResult: Map<string, MiniAppBuildResult>;
  private saveLock: Promise<void> | null = null;
  private initPromise: Promise<void> | null = null;
  /** PAPR_HOME at last successful initialize — prune must not run after env drift. */
  private loadedPaprRoot: string | null = null;
  /**
   * Set by cleanup(). Watcher startup is fire-and-forget, so without this a
   * shutdown that lands mid-startup creates watchers *after* cleanup already
   * closed the set — they then outlive the service with nothing tracking them.
   */
  private disposed = false;

  /** Coalesce rapid multi-file agent edits into one rebuild + reload. */
  private static readonly FILE_CHANGE_DEBOUNCE_MS = 800;
  /** Wait for edit bursts to settle after build before telling UI to reload. */
  private static readonly RELOAD_BROADCAST_DEBOUNCE_MS = 1500;

  /** Mini-app source files subject to the 100-line limit. */
  private static readonly MINI_APP_LOC_CHECK_EXTENSIONS = new Set([
    ".html",
    ".css",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
  ]);

  /** Long-form content assets — served by the gateway but not LOC-checked. */
  private static readonly MINI_APP_CONTENT_EXTENSIONS = new Set([
    ".md",
    ".markdown",
    ".json",
    ".txt",
  ]);

  /** System-provided scaffold files — not subject to the 100-line agent limit. */
  private static readonly MINI_APP_LOC_EXEMPT_BASENAMES = new Set([
    "base.css",
  ]);

  constructor() {
    const homeDir = os.homedir();
    this.legacyAppsDir = path.join(homeDir, ".paprwork", "apps");
    this.legacyAppsIndexPath = path.join(
      homeDir,
      ".paprwork",
      "data",
      "apps.json",
    );
    this.apps = new Map();
    this.initialized = false;
    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.reloadBroadcastTimers = new Map();
    this.buildInFlight = new Map();
    this.pendingDefaultJobs = [];
    this.lastBuildResult = new Map();
  }

  private get paprRootDir(): string {
    return getPaprRoot();
  }

  private get appsDir(): string {
    return getPaprAppsRoot();
  }

  private get appsIndexPath(): string {
    return path.join(getPaprDataDir(), "apps.json");
  }

  /** Reload index from disk after PAPR_HOME changes (cloud agent gateway). */
  async resetForWorkspaceReload(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.buildInFlight.clear();
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
    this.initialized = false;
    this.loadedPaprRoot = null;
    this.apps.clear();
    this.pendingDefaultJobs = [];
    this.lastBuildResult.clear();
  }

  private async migrateLegacyIfNeeded(): Promise<void> {
    let hasNewIndex = true;
    try {
      await fs.access(this.appsIndexPath);
    } catch {
      hasNewIndex = false;
    }

    let hasLegacyIndex = true;
    try {
      await fs.access(this.legacyAppsIndexPath);
    } catch {
      hasLegacyIndex = false;
    }

    if (!hasNewIndex && hasLegacyIndex) {
      await fs.mkdir(path.dirname(this.appsIndexPath), { recursive: true });
      await fs.copyFile(this.legacyAppsIndexPath, this.appsIndexPath);
    }

    let hasNewAppsDir = true;
    try {
      await fs.access(this.appsDir);
    } catch {
      hasNewAppsDir = false;
    }

    let hasLegacyAppsDir = true;
    try {
      await fs.access(this.legacyAppsDir);
    } catch {
      hasLegacyAppsDir = false;
    }

    if (!hasNewAppsDir && hasLegacyAppsDir) {
      await fs.mkdir(path.dirname(this.appsDir), { recursive: true });
      await fs.cp(this.legacyAppsDir, this.appsDir, { recursive: true });
    }
  }

  /**
   * Install default apps from src/resources/default-apps/ if they don't exist yet.
   * Called on first launch to provide pre-built apps like the home dashboard.
   */
  private async installDefaultApps(): Promise<void> {
    try {
      // Path to bundled default apps (in dist after build)
      // __dirname is dist/gateway/services/ so we need to go up 2 levels to reach dist/
      const defaultAppsDir = path.join(__dirname, "..", "..", "resources", "default-apps");
      
      // Check if default apps directory exists (may not exist in dev mode before first build)
      try {
        await fs.access(defaultAppsDir);
      } catch {
        console.log("[AppService] No default apps directory found, skipping installation");
        return;
      }

      // Get list of default apps
      const defaultAppDirs = await fs.readdir(defaultAppsDir);
      let installedCount = 0;
      
      for (const appDirName of defaultAppDirs) {
        const sourceDir = path.join(defaultAppsDir, appDirName);
        const stat = await fs.stat(sourceDir);
        
        if (!stat.isDirectory()) continue;

        // Read app ID from app-id.txt
        const appIdPath = path.join(sourceDir, "app-id.txt");
        let appId: string;
        try {
          appId = (await fs.readFile(appIdPath, "utf-8")).trim();
        } catch {
          console.warn(`[AppService] Skipping default app ${appDirName}: no app-id.txt`);
          continue;
        }

        // Check if app already exists (both in registry and on disk)
        if (this.apps.has(appId)) {
          const targetDir2 = path.join(this.appsDir, appId);

          // Check if bundled version is newer and update app files if so
          await this.updateDefaultAppIfNewer(sourceDir, targetDir2, appId);

          // Ensure the associated job exists (handles upgrades)
          await this.installDefaultJobForApp(sourceDir, targetDir2, appId);
          continue;
        }

        const targetDir = path.join(this.appsDir, appId);
        let needsInstall = false;
        try {
          await fs.access(targetDir);
          console.log(`[AppService] Default app files exist but not in registry: ${appId}`);
          // Files exist but not registered - add to registry below
        } catch {
          // App doesn't exist, install files
          needsInstall = true;
        }

        if (needsInstall) {
          // Copy app files
          await fs.mkdir(targetDir, { recursive: true });
          await fs.cp(sourceDir, targetDir, { recursive: true });
          console.log(`[AppService] Copied default app files: ${appId} (${appDirName})`);
        }

        // Read metadata.json to get app details
        const metadataPath = path.join(sourceDir, "metadata.json");
        let metadata: Partial<MiniApp> & { defaultHomeApp?: boolean; isDefault?: boolean };
        try {
          const metadataContent = await fs.readFile(metadataPath, "utf-8");
          metadata = JSON.parse(metadataContent);
        } catch {
          console.warn(`[AppService] No metadata.json found for default app ${appId}, using defaults`);
          metadata = {
            id: appId,
            title: appDirName,
            description: "Default app",
            type: "app",
          };
        }

        // Read icon from directory if not in metadata
        let icon: string | undefined = metadata.icon;
        if (!icon) {
          const resolvedIcon = await this.resolveIconFromAppDir(targetDir);
          if (resolvedIcon) {
            icon = resolvedIcon;
          }
        }

        // Create app entry in registry
        const now = new Date().toISOString();
        const scope = readActiveAppWorkspaceScope();
        const app: MiniApp = {
          id: appId,
          title: metadata.title || appDirName,
          description: metadata.description || "Default app",
          type: "app",
          createdAt: metadata.createdAt || now,
          updatedAt: now,
          favorite: metadata.favorite || false,
          ...(getPaprUserId()?.trim()
            ? { ownerUserId: getPaprUserId()!.trim() }
            : {}),
          ...(scope ? withWorkspaceScope({}, scope) : {}),
          ...(icon ? { icon } : {}),
        };

        this.apps.set(appId, app);
        installedCount++;
        
        console.log(`[AppService] Registered default app: ${appId} - ${app.title}`);

        // Install associated default job if bundled with the app
        await this.installDefaultJobForApp(sourceDir, targetDir, appId);
      }

      // Save apps index if any apps were installed
      if (installedCount > 0) {
        await this.saveApps();
        console.log(`[AppService] Installed and registered ${installedCount} default app(s)`);
      }
    } catch (error) {
      console.error("[AppService] Failed to install default apps:", error);
      // Don't throw - default apps are nice-to-have, not critical
    }
  }

  /**
   * Install a default job bundled with an app (default-job.json) and link its
   * database into the app's data-sources.json so queries work immediately.
   *
   * IMPORTANT: This is deferred so it doesn't trigger a full JobsService.initialize()
   * during AppService init — with 300+ jobs that scan takes longer than the
   * supervisor health-check timeout, causing an infinite restart loop.
   */
  private async installDefaultJobForApp(
    sourceDir: string,
    targetDir: string,
    appId: string,
  ): Promise<void> {
    const jobDefPath = path.join(sourceDir, "default-job.json");
    try {
      await fs.access(jobDefPath);
    } catch {
      return; // No default job bundled — nothing to do
    }

    // Schedule deferred installation after Gateway finishes all service inits.
    // JobsService.initialize() is called by Gateway AFTER AppService, so we
    // wait for it to be ready instead of triggering a redundant heavy init.
    this.pendingDefaultJobs.push({ sourceDir, targetDir, appId });
  }

  /**
   * Run deferred default-job installations. Called by Gateway after
   * JobsService has been fully initialized.
   */
  async installPendingDefaultJobs(): Promise<void> {
    if (this.pendingDefaultJobs.length === 0) return;

    const pending = [...this.pendingDefaultJobs];
    this.pendingDefaultJobs = [];

    for (const { sourceDir, targetDir, appId } of pending) {
      try {
        await this.doInstallDefaultJobForApp(sourceDir, targetDir, appId);
      } catch (err) {
        console.warn(`[AppService] Failed to install default job for app ${appId}:`, err);
      }
    }

    try {
      const { getJobsService } = await import("./JobsService.js");
      const { repairDefaultHomeAppLinkedSources } = await import(
        "./defaultHomeAppRepair.js"
      );
      const jobsService = getJobsService();
      const repair = await repairDefaultHomeAppLinkedSources({
        appsDir: this.appsDir,
        jobExists: (jobId) => jobsService.hasJob(jobId),
        resolveJobDbPath: (jobId) =>
          path.join(jobsService.getJobsRootPath(), jobId, "data", "data.db"),
      });
      if (
        repair.prunedSources > 0 ||
        repair.schemaRepaired > 0 ||
        repair.dbPathsUpdated > 0
      ) {
        console.log(
          `[AppService] Repaired Home app data-sources: pruned=${repair.prunedSources} schema=${repair.schemaRepaired} dbPaths=${repair.dbPathsUpdated}`,
        );
      }
    } catch (err) {
      console.warn("[AppService] Home app data-source repair failed:", err);
    }
  }

  private async doInstallDefaultJobForApp(
    sourceDir: string,
    targetDir: string,
    appId: string,
  ): Promise<void> {
    const jobDefPath = path.join(sourceDir, "default-job.json");
    const jobDefContent = await fs.readFile(jobDefPath, "utf-8");
    const jobDef = JSON.parse(jobDefContent) as {
      id: string;
      name: string;
      type: string;
      command?: string;
      schedule?: Record<string, unknown>;
      retries?: Record<string, unknown>;
      outputMode?: string;
      memoryPolicy?: string;
    };

    const { getJobsService } = await import("./JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const { installed, dbPath } = await jobsService.installDefaultJob(
      {
        ...(jobDef as Parameters<typeof jobsService.installDefaultJob>[0]),
        appIds: [appId],
      },
      [
        `CREATE TABLE IF NOT EXISTS briefs (
          date TEXT PRIMARY KEY,
          brief_json TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
      ],
    );

    // Update data-sources.json with the resolved dbPath
    const dataSourcesPath = path.join(targetDir, "data-sources.json");
    try {
      const dsContent = await fs.readFile(dataSourcesPath, "utf-8");
      const config = parseDataSourcesFile(dsContent);

      let updated = false;
      for (const ds of config.sources) {
        if (ds.jobId === jobDef.id && (!ds.dbPath || ds.dbPath === "")) {
          ds.dbPath = dbPath;
          updated = true;
        }
      }

      if (updated) {
        await fs.writeFile(
          dataSourcesPath,
          serializeDataSourcesFile(config),
          "utf8",
        );
        console.log(`[AppService] Linked data-source dbPath for app ${appId} → ${dbPath}`);
      }
    } catch (dsErr) {
      console.warn(`[AppService] Could not update data-sources.json for ${appId}:`, dsErr);
    }

    if (installed) {
      console.log(`[AppService] Installed default job ${jobDef.id} for app ${appId}`);
    }
  }

  /**
   * Compare bundled metadata version with installed version and re-copy
   * app files if the bundle is newer (preserves user's data-sources.json).
   */
  private async updateDefaultAppIfNewer(
    sourceDir: string,
    targetDir: string,
    appId: string,
  ): Promise<void> {
    try {
      const srcMeta = JSON.parse(
        await fs.readFile(path.join(sourceDir, "metadata.json"), "utf-8"),
      ) as { version?: number };
      const bundledVersion = srcMeta.version ?? 0;
      if (bundledVersion <= 0) return;

      let installedVersion = 0;
      try {
        const tgtMeta = JSON.parse(
          await fs.readFile(path.join(targetDir, "metadata.json"), "utf-8"),
        ) as { version?: number };
        installedVersion = tgtMeta.version ?? 0;
      } catch {
        // metadata missing — treat as version 0
      }

      if (bundledVersion <= installedVersion) return;

      // Preserve user-specific files before overwrite
      let savedDataSources: string | null = null;
      const dsPath = path.join(targetDir, "data-sources.json");
      try {
        savedDataSources = await fs.readFile(dsPath, "utf-8");
      } catch { /* no data-sources to preserve */ }

      await fs.cp(sourceDir, targetDir, { recursive: true });

      // Restore user's dbPath values for bundled default apps; full restore for others
      if (savedDataSources) {
        const bundledMeta = await this.readBundledDefaultAppMetadata(sourceDir);
        if (
          bundledMeta?.isDefault ||
          bundledMeta?.defaultHomeApp ||
          appId === DEFAULT_HOME_APP_ID
        ) {
          await this.mergeBundledDefaultAppDataSources(
            targetDir,
            sourceDir,
            savedDataSources,
          );
        } else {
          await fs.writeFile(dsPath, savedDataSources);
        }
      }

      console.log(
        `[AppService] Updated default app ${appId} from v${installedVersion} → v${bundledVersion}`,
      );
    } catch (err) {
      console.warn(`[AppService] Could not check/update default app ${appId}:`, err);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async runInitialize(): Promise<void> {
    if (this.initialized) return;

    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.appsDir, { recursive: true });
    await fs.mkdir(path.dirname(this.appsIndexPath), { recursive: true });
    await this.loadApps(); // Load existing apps FIRST
    await this.enforceAppOwnershipIndex(); // Drop foreign apps before recovery
    await this.rebuildIndexIfCorrupted(); // Safety net: check for missing apps
    await this.backfillAppAgentChatFromDisk(); // Sidecar + registry from metadata/registry
    await this.backfillAppWorkspaceScope(); // Apps on disk in this namespace must have org/ns
    await this.repairRecoveredAppEntries(); // Fix legacy "Recovered" labels from metadata.json
    await this.syncBundledDefaultAppRegistry(); // Keep prebuilt apps (Home) in sync with bundled metadata
    await this.pruneStaleAppEntries(); // Index entries whose folders were removed (e.g. bash rm)
    await this.installDefaultApps(); // Then install defaults (won't overwrite existing)
    const { initializeDatabaseRegistry } = await import(
      "./DatabaseRegistryService.js"
    );
    await initializeDatabaseRegistry();
    this.loadedPaprRoot = this.paprRootDir;
    this.initialized = true;
    console.log(`[AppService] Initialized with ${this.apps.size} apps (watchers starting in background)`);
    this.scheduleWatchingApps();
  }

  /** File watchers are not needed to serve list/open/build — start after init returns. */
  private scheduleWatchingApps(): void {
    void this.startWatchingApps().catch((error: unknown) => {
      console.warn(
        "[AppService] Background watcher startup failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  isInitialized(): boolean {
    return this.initialized;
  }


  /**
   * Safety net: detect if apps.json is missing apps that exist on disk.
   * This handles corruption from updates, crashes, or the previous bug where
   * installDefaultApps() could overwrite apps.json before loadApps() ran.
   * Scans ~/Papr/apps/ for app directories not in the index and re-adds them.
   */
  /** Remove teammate / team-catalog apps from local index; stamp owner on legacy entries. */
  async enforceAppOwnershipIndex(): Promise<void> {
    const currentUserId = getPaprUserId()?.trim();
    if (!currentUserId) {
      return;
    }

    const namespaceId = resolveActiveNamespaceId();
    const foreignPublisherAppIds = namespaceId
      ? await fetchForeignPublisherAppIds(namespaceId)
      : new Map<string, string>();

    let dirty = false;
    const toRemove: string[] = [];

    for (const [appId, app] of this.apps.entries()) {
      const appDir = path.join(this.appsDir, appId);
      const hints = await readAppDiskOwnershipHints(appDir, appId);

      // Team catalog may list the same appId under a teammate's cloud publish on
      // shared git disk — keep it in My Apps when this user owns the local copy.
      if (
        foreignPublisherAppIds.has(appId) &&
        !isAppOwnedByCurrentUser(app, hints)
      ) {
        toRemove.push(appId);
        continue;
      }

      if (!isAppOwnedByCurrentUser(app, hints)) {
        toRemove.push(appId);
        continue;
      }

      if (!app.ownerUserId) {
        app.ownerUserId = currentUserId;
        dirty = true;
      }
    }

    for (const appId of toRemove) {
      this.apps.delete(appId);
      dirty = true;
      console.log(
        `[AppService] Removed foreign app from My Apps index: ${appId}`,
      );
    }

    if (dirty) {
      await this.saveApps();
    }
  }

  private async readMetadataHintsFromAppDir(
    appDir: string,
  ): Promise<{
    title?: string;
    description?: string;
    icon?: string;
    updatedAt?: string;
  }> {
    try {
      const raw = await fs.readFile(path.join(appDir, "metadata.json"), "utf-8");
      const metadata = parseCloudAppMetadataFile(raw);
      if (metadata) {
        return {
          title: metadata.title,
          description: metadata.description,
          icon: metadata.icon,
          updatedAt: metadata.updatedAt,
        };
      }
    } catch {
      // fall through to index.html
    }

    try {
      const indexHtml = await fs.readFile(path.join(appDir, "index.html"), "utf-8");
      const titleMatch = indexHtml.match(/<title>([^<]+)<\/title>/i);
      const favicon = this.extractFaviconFromHTML(indexHtml);
      return {
        ...(titleMatch ? { title: titleMatch[1].trim() } : {}),
        ...(favicon ? { icon: favicon } : {}),
      };
    } catch {
      return {};
    }
  }

  /** Fix apps index entries that still carry the legacy recovered placeholder. */
  private async repairRecoveredAppEntries(): Promise<void> {
    let dirty = false;

    for (const app of this.apps.values()) {
      const appDir = path.join(this.appsDir, app.id);
      const hints = await this.readMetadataHintsFromAppDir(appDir);
      const titleIsPlaceholder =
        !app.title ||
        app.title === app.id ||
        app.title.startsWith(app.id.slice(0, 8));
      const needsRepair =
        app.description === RECOVERED_INDEX_DESCRIPTION ||
        (titleIsPlaceholder && Boolean(hints.title));
      if (!needsRepair) continue;

      if (!hints.title && !hints.description) continue;

      if (hints.title && titleIsPlaceholder) {
        app.title = hints.title;
      }
      if (
        hints.description &&
        hints.description !== RECOVERED_INDEX_DESCRIPTION
      ) {
        app.description = hints.description;
      }
      if (hints.icon && !app.icon) {
        app.icon = hints.icon;
      }
      if (hints.updatedAt) {
        app.updatedAt = hints.updatedAt;
      }
      dirty = true;
      console.log(
        `[AppService] Repaired recovered app metadata: ${app.id} - ${app.title}`,
      );
    }

    if (dirty) {
      await this.saveApps();
    }
  }

  private async readBundledDefaultAppMetadata(
    sourceDir: string,
  ): Promise<{
    isDefault?: boolean;
    defaultHomeApp?: boolean;
    version?: number;
  } | null> {
    try {
      const raw = await fs.readFile(
        path.join(sourceDir, "metadata.json"),
        "utf-8",
      );
      return JSON.parse(raw) as {
        isDefault?: boolean;
        defaultHomeApp?: boolean;
        version?: number;
      };
    } catch {
      return null;
    }
  }

  /** Sync registry title/description for prebuilt apps from on-disk metadata.json. */
  private async syncBundledDefaultAppRegistry(): Promise<void> {
    let dirty = false;

    for (const app of this.apps.values()) {
      const appDir = path.join(this.appsDir, app.id);
      let metadata: {
        isDefault?: boolean;
        defaultHomeApp?: boolean;
        title?: string;
        description?: string;
        icon?: string;
        updatedAt?: string;
      };
      try {
        const raw = await fs.readFile(
          path.join(appDir, "metadata.json"),
          "utf-8",
        );
        metadata = JSON.parse(raw) as typeof metadata;
      } catch {
        continue;
      }

      if (!metadata.isDefault && !metadata.defaultHomeApp) {
        continue;
      }

      let appDirty = false;
      if (metadata.title && app.title !== metadata.title) {
        app.title = metadata.title;
        appDirty = true;
      }
      if (
        metadata.description &&
        (app.description === RECOVERED_INDEX_DESCRIPTION ||
          app.description !== metadata.description)
      ) {
        app.description = metadata.description;
        appDirty = true;
      }
      if (metadata.icon && !app.icon) {
        app.icon = metadata.icon;
        appDirty = true;
      }
      if (metadata.updatedAt && app.updatedAt !== metadata.updatedAt) {
        app.updatedAt = metadata.updatedAt;
        appDirty = true;
      }

      const scope = readActiveAppWorkspaceScope();
      if (
        scope &&
        (app.organizationId !== scope.organizationId ||
          app.namespaceId !== scope.namespaceId)
      ) {
        app.organizationId = scope.organizationId;
        app.namespaceId = scope.namespaceId;
        appDirty = true;
      }

      if (appDirty) {
        dirty = true;
        console.log(
          `[AppService] Synced bundled default app registry: ${app.id} - ${app.title}`,
        );
      }
    }

    if (dirty) {
      await this.saveApps();
    }
  }

  private async mergeBundledDefaultAppDataSources(
    targetDir: string,
    sourceDir: string,
    savedDataSources: string,
  ): Promise<void> {
    const bundledPath = path.join(sourceDir, "data-sources.json");
    const targetPath = path.join(targetDir, "data-sources.json");

    let bundledConfig: AppDataSourcesFile;
    try {
      bundledConfig = parseDataSourcesFile(
        await fs.readFile(bundledPath, "utf-8"),
      );
    } catch {
      await fs.writeFile(targetPath, savedDataSources);
      return;
    }

    const savedDbPaths = new Map<string, string>();
    try {
      const savedConfig = parseDataSourcesFile(savedDataSources);
      for (const source of savedConfig.sources ?? []) {
        if (source.jobId && source.dbPath?.trim()) {
          savedDbPaths.set(source.jobId, source.dbPath.trim());
        }
      }
    } catch {
      // Use bundled template as-is
    }

    const activeHome = path.resolve(getPaprRoot());
    for (const source of bundledConfig.sources ?? []) {
      const savedPath = source.jobId
        ? savedDbPaths.get(source.jobId)
        : undefined;
      if (!savedPath) {
        continue;
      }
      // Same app id is installed in every org/namespace — only keep dbPath values
      // that belong to the active workspace (not a sibling namespace copy).
      const normalizedSaved = path.resolve(savedPath);
      if (
        normalizedSaved.startsWith(`${activeHome}${path.sep}`) ||
        normalizedSaved === activeHome
      ) {
        source.dbPath = savedPath;
      }
    }

    await fs.writeFile(
      targetPath,
      serializeDataSourcesFile(bundledConfig),
      "utf8",
    );
    console.log(
      `[AppService] Merged bundled data-sources for default app in ${path.basename(targetDir)}`,
    );
  }

  private async rebuildIndexIfCorrupted(): Promise<void> {
    try {
      const dirsOnDisk = await fs.readdir(this.appsDir);
      const appDirsOnDisk: string[] = [];

      for (const dirName of dirsOnDisk) {
        const dirPath = path.join(this.appsDir, dirName);
        try {
          const stat = await fs.stat(dirPath);
          if (!stat.isDirectory()) continue;
          // Must have at least one file (not an empty dir)
          const files = await fs.readdir(dirPath);
          if (files.length === 0) continue;
          appDirsOnDisk.push(dirName);
        } catch {
          continue;
        }
      }

      // Find apps on disk but missing from index
      const missingAppIds = appDirsOnDisk.filter(id => !this.apps.has(id));

      if (missingAppIds.length === 0) return;

      const namespaceId = resolveActiveNamespaceId();
      const foreignPublisherAppIds = namespaceId
        ? await fetchForeignPublisherAppIds(namespaceId)
        : new Map<string, string>();

      const recoverableAppIds: string[] = [];
      for (const appId of missingAppIds) {
        const appDir = path.join(this.appsDir, appId);
        const allowed = await shouldIndexAppFolderForCurrentUser(
          appId,
          appDir,
          foreignPublisherAppIds,
        );
        if (allowed) {
          recoverableAppIds.push(appId);
        } else {
          console.warn(
            `[AppService] Skipped foreign app folder during index rebuild: ${appId}`,
          );
        }
      }

      if (recoverableAppIds.length === 0) return;

      console.warn(
        `[AppService] INDEX CORRUPTION DETECTED: ${recoverableAppIds.length} apps on disk but missing from apps.json. Rebuilding...`
      );

      // Back up the corrupted index before fixing
      try {
        const backupPath = this.appsIndexPath + `.backup-${Date.now()}`;
        await fs.copyFile(this.appsIndexPath, backupPath);
        console.log(`[AppService] Backed up corrupted index to ${backupPath}`);
      } catch {
        // No existing file to back up — that's fine
      }

      for (const appId of recoverableAppIds) {
        const appDir = path.join(this.appsDir, appId);
        const hints = await this.readMetadataHintsFromAppDir(appDir);

        let title = hints.title ?? appId;
        let description =
          hints.description ?? RECOVERED_INDEX_DESCRIPTION;
        let icon: string | undefined = hints.icon;
        let createdAt = new Date().toISOString();

        if (!icon) {
          const resolvedIcon = await this.resolveIconFromAppDir(appDir);
          if (resolvedIcon) {
            icon = resolvedIcon;
          }
        }

        // Try to get actual creation date from filesystem
        try {
          const stat = await fs.stat(appDir);
          createdAt = stat.birthtime.toISOString();
        } catch {
          // Use current time
        }

        const hydration = await hydrateAppAgentChatFromDisk(
          this.paprRootDir,
          appId,
        );

        const scope = readActiveAppWorkspaceScope();

        const recoveredApp: MiniApp = {
          id: appId,
          title,
          description,
          type: "app",
          createdAt,
          updatedAt: hints.updatedAt ?? new Date().toISOString(),
          ...(getPaprUserId()?.trim()
            ? { ownerUserId: getPaprUserId()!.trim() }
            : {}),
          ...(scope ? withWorkspaceScope({}, scope) : {}),
          ...(icon ? { icon } : {}),
          ...(hydration.agentChat ? { agentChat: hydration.agentChat } : {}),
        };

        this.apps.set(appId, recoveredApp);
        console.log(`[AppService] Recovered app from disk: ${appId} - ${title}`);
      }

      await this.saveApps();
      console.log(
        `[AppService] Index rebuilt: recovered ${recoverableAppIds.length} apps. Total: ${this.apps.size}`
      );
    } catch (error) {
      console.error("[AppService] Failed to rebuild index:", error);
      // Don't throw — better to have some apps than crash
    }
  }

  private async loadApps(): Promise<void> {
    try {
      const data = await fs.readFile(this.appsIndexPath, "utf-8");
      const appsArray: MiniApp[] = JSON.parse(data);
      this.apps = new Map(appsArray.map((app) => [app.id, app]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.apps = new Map();
        return;
      }
      console.error("[AppService] Failed to load apps:", error);

      try {
        const backupPath = this.appsIndexPath + `.corrupt-${Date.now()}`;
        await fs.copyFile(this.appsIndexPath, backupPath);
        console.warn(`[AppService] Backed up corrupt apps.json to ${backupPath}`);
      } catch {
        // backup failed — not critical
      }
      this.apps = new Map();
    }

    // Backfill icons for existing apps that don't have one yet
    let dirty = false;
    for (const app of this.apps.values()) {
      if (!app.icon) {
        const appDir = path.join(this.appsDir, app.id);
        const dirIcon = await this.resolveIconFromAppDir(appDir);
        if (dirIcon) {
          app.icon = dirIcon;
          dirty = true;
          console.log(`[AppService] Resolved icon from logo file for app: ${app.id}`);
        }
      }
    }
    if (dirty) {
      await this.saveApps();
    }

    let agentChatHydrated = false;
    for (const app of this.apps.values()) {
      const hydration = await hydrateAppAgentChatFromDisk(
        this.paprRootDir,
        app.id,
        app.agentChat,
      );
      if (!hydration.agentChat) continue;
      if (
        !app.agentChat?.enabled ||
        hydration.registryNeedsUpdate ||
        hydration.sidecarBackfilled
      ) {
        app.agentChat = hydration.agentChat;
        agentChatHydrated = true;
        console.log(
          `[AppService] Restored app agent chat for ${app.id}` +
            (hydration.sidecarBackfilled ? " (sidecar backfilled)" : ""),
        );
      }
    }
    if (agentChatHydrated) {
      await this.saveApps();
      for (const app of this.apps.values()) {
        if (app.agentChat?.enabled) {
          void writeCloudAppMetadataFile(this.paprRootDir, app.id).catch(() => {});
        }
      }
    }
  }

  /** Backfill agent-chat.json + registry after rebuild or cloud sync pull. */
  private async backfillAppAgentChatFromDisk(): Promise<void> {
    let dirty = false;
    for (const app of this.apps.values()) {
      const hydration = await hydrateAppAgentChatFromDisk(
        this.paprRootDir,
        app.id,
        app.agentChat,
      );
      if (!hydration.agentChat) continue;
      if (
        !app.agentChat?.enabled ||
        hydration.registryNeedsUpdate ||
        hydration.sidecarBackfilled
      ) {
        app.agentChat = hydration.agentChat;
        dirty = true;
      }
    }
    if (!dirty) return;

    await this.saveApps();
    for (const app of this.apps.values()) {
      if (app.agentChat?.enabled) {
        await writeCloudAppMetadataFile(this.paprRootDir, app.id).catch((err) => {
          console.warn(
            `[AppService] Failed to write metadata.json for ${app.id}:`,
            (err as Error).message,
          );
        });
      }
    }
  }

  /**
   * Apps stored under the active org/namespace workspace belong to that workspace.
   * Index rebuilds can strip organizationId/namespaceId — restore so listApps shows them.
   */
  private async backfillAppWorkspaceScope(): Promise<void> {
    const scope = readActiveAppWorkspaceScope();
    if (!scope) {
      return;
    }

    let dirty = false;
    for (const app of this.apps.values()) {
      if (!(await this.appDirHasContent(app.id))) {
        continue;
      }

      const diskFields = await readAppWorkspaceFieldsFromDisk(
        path.join(this.appsDir, app.id),
      );
      const merged = mergeAppWorkspaceFields(app, diskFields);
      if (!isAppWorkspaceUnassigned(merged)) {
        continue;
      }

      const scoped = withWorkspaceScope(app, scope);
      scoped.updatedAt = new Date().toISOString();
      this.apps.set(app.id, scoped);
      dirty = true;
      console.log(
        `[AppService] Restored workspace scope for app: ${app.id} → ${scope.organizationId}/${scope.namespaceId}`,
      );
    }

    if (!dirty) {
      return;
    }

    await this.saveApps();
    for (const app of this.apps.values()) {
      if (
        app.organizationId === scope.organizationId &&
        app.namespaceId === scope.namespaceId
      ) {
        await writeCloudAppMetadataFile(this.paprRootDir, app.id).catch(() => {});
      }
    }
  }

  private async saveApps(): Promise<void> {
    if (this.saveLock) {
      await this.saveLock;
    }

    this.saveLock = (async () => {
      try {
        for (const app of this.apps.values()) {
          if (app.agentChat?.enabled) continue;
          const resolved = await resolveAppAgentChatConfig(
            this.paprRootDir,
            app.id,
            app.agentChat,
          );
          if (!resolved?.enabled) continue;
          app.agentChat = resolved;
          console.warn(
            `[AppService] Prevented agentChat strip on save for app: ${app.id}`,
          );
        }

        const appsArray = Array.from(this.apps.values());
        const data = JSON.stringify(appsArray, null, 2);
        const tmpPath =
          this.appsIndexPath +
          `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        await fs.writeFile(tmpPath, data, "utf8");
        await fs.rename(tmpPath, this.appsIndexPath);
      } finally {
        this.saveLock = null;
      }
    })();

    await this.saveLock;
  }

  /**
   * Extract favicon from an HTML string's <link rel="icon"> tag.
   * Supports SVG data URIs (preferred — returns raw SVG string) and
   * PNG/other base64 data URIs (fallback — returns the full data URI).
   */
  private extractFaviconFromHTML(html: string): string | null {
    const linkMatch = html.match(/<link[^>]+rel=["']icon["'][^>]*>/i);
    if (!linkMatch) return null;

    const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return null;

    const href = hrefMatch[1];

    // Prefer SVG — compact and scalable
    if (href.startsWith("data:image/svg+xml,")) {
      let svgContent = href.substring("data:image/svg+xml,".length);
      try {
        if (svgContent.includes("%")) {
          svgContent = decodeURIComponent(svgContent);
        }
      } catch {
        return null;
      }

      if (
        !svgContent.trim().startsWith("<svg") ||
        !svgContent.includes("</svg>")
      ) {
        return null;
      }

      // Use single quotes for JSON compatibility
      svgContent = svgContent.replace(/"/g, "'");

      // Ensure small dimensions for tab/favorites use (14px)
      if (!svgContent.includes("width=")) {
        svgContent = svgContent.replace("<svg", "<svg width='14' height='14'");
      }

      return svgContent;
    }

    // Fallback: PNG/GIF/WEBP base64 data URI — store the full data URI as the icon
    if (href.startsWith("data:image/") && href.includes(";base64,")) {
      // Only accept reasonably-sized icons (< 32KB encoded) to avoid bloating the index
      if (href.length <= 44000) {
        return href;
      }
      console.log("[AppService] Skipping oversized base64 favicon:", href.length, "chars");
      return null;
    }

    return null;
  }

  /**
   * Try to resolve an SVG icon from known logo files in the app directory.
   * Checks logo.svg, icon.svg, and favicon.svg (in priority order).
   * Returns the SVG string sized for tab/sidebar use, or null.
   */
  private async resolveIconFromAppDir(appDir: string): Promise<string | null> {
    const candidates = ["logo.svg", "icon.svg", "favicon.svg"];

    for (const filename of candidates) {
      const filePath = path.join(appDir, filename);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const trimmed = content.trim();
        if (!trimmed.startsWith("<svg") || !trimmed.includes("</svg>")) {
          continue;
        }

        let svg = trimmed.replace(/"/g, "'");

        // Normalise to small dimensions for tab/sidebar rendering
        svg = svg
          .replace(/width=['"][^'"]*['"]/i, "width='14'")
          .replace(/height=['"][^'"]*['"]/i, "height='14'");

        if (!svg.includes("width=")) {
          svg = svg.replace("<svg", "<svg width='14' height='14'");
        }

        return svg;
      } catch {
        // File doesn't exist — try next candidate
      }
    }

    return null;
  }

  async createApp(
    title: string,
    description: string,
    files: AppFile[],
    icon?: string,
    createdByAgentId?: string,
    createdByAgentName?: string,
    tags?: string[],
  ): Promise<MiniApp> {
    const now = new Date().toISOString();
    const { ensureUniqueAppTitle } = await import("../utils/uniqueAppNaming.js");
    const uniqueTitle = ensureUniqueAppTitle(
      title,
      [...this.apps.values()].map((existing) => existing.title),
    );
    if (uniqueTitle !== title.trim()) {
      console.log(
        `[AppService] Renamed duplicate app title ${JSON.stringify(title)} → ${JSON.stringify(uniqueTitle)}`,
      );
    }

    // Resolve icon: explicit icon wins, then auto-extract from index.html favicon
    let resolvedIcon = icon ?? null;
    if (!resolvedIcon) {
      const indexFile = files.find((f) => f.filename === "index.html");
      if (indexFile) {
        resolvedIcon = this.extractFaviconFromHTML(indexFile.content);
      }
    }
    if (resolvedIcon) {
      const sanitizedIcon = sanitizeMiniAppIcon(resolvedIcon);
      if (!sanitizedIcon) {
        const iconResult = validateMiniAppIcon(resolvedIcon);
        console.warn(
          `[AppService] Dropping invalid icon for ${JSON.stringify(uniqueTitle)}` +
            (iconResult.ok ? "" : `: ${iconResult.message}`),
        );
        resolvedIcon = null;
      } else {
        resolvedIcon = sanitizedIcon;
      }
    }

    const scope = readActiveAppWorkspaceScope();
    const { normalizeCatalogTags } = await import("../../core/utils/catalogTags.js");
    const normalizedTags = normalizeCatalogTags(tags);
    const app: MiniApp = {
      id: uuidv4(),
      title: uniqueTitle,
      description,
      type: "app",
      createdAt: now,
      updatedAt: now,
      favorite: false,
      ...(getPaprUserId()?.trim()
        ? { ownerUserId: getPaprUserId()!.trim() }
        : {}),
      ...(scope ? withWorkspaceScope({}, scope) : {}),
      ...(resolvedIcon ? { icon: resolvedIcon } : {}),
      ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
      createdByAgentId,
      createdByAgentName,
    };

    // Create app directory
    const appPath = path.join(this.appsDir, app.id);
    await fs.mkdir(appPath, { recursive: true });

    // Write all files in parallel and ensure they're flushed to disk.
    // Create subdirectories as needed (e.g. components/, utils/).
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(appPath, file.filename);
        const dir = path.dirname(filePath);
        if (dir !== appPath) {
          await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(filePath, file.content, { flush: true });
      }),
    );

    const hasDbTs = files.some((f) => path.basename(f.filename) === "db.ts");
    if (!hasDbTs) {
      await fs.writeFile(
        path.join(appPath, "db.ts"),
        buildAppDbTsContent(app.id, []),
        "utf8",
      );
    }

    // Verify critical file (index.html) exists and is readable
    // This ensures files are actually on disk before returning
    const indexPath = path.join(appPath, "index.html");
    try {
      await fs.access(indexPath, fs.constants.R_OK);
    } catch (error) {
      throw new Error(
        `Failed to create app: index.html not accessible after write. ` +
          `This may indicate a filesystem sync issue.`,
      );
    }

    // If still no icon, try to read a logo SVG from the app directory
    if (!app.icon) {
      const dirIcon = sanitizeMiniAppIcon(await this.resolveIconFromAppDir(appPath));
      if (dirIcon) {
        app.icon = dirIcon;
      }
    }

    this.apps.set(app.id, app);
    await this.saveApps();

    // Start watching the new app directory for changes
    await this.watchApp(app.id);

    import("./gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_app_created", {
        app_id: app.id,
        app_name: uniqueTitle.length > 80 ? `${uniqueTitle.slice(0, 79)}…` : uniqueTitle,
        has_icon: !!app.icon,
        file_count: files.length,
      });
    }).catch(() => {});

    console.log(
      `[AppService] Created app: ${app.id} - ${uniqueTitle} (verified files on disk)`,
    );

    void this.autoDiscoverDataSources(app.id).catch((err) => {
      console.warn(
        `[AppService] Auto-discovery failed for new app ${app.id}:`,
        err,
      );
    });

    void writeCloudAppMetadataFile(this.paprRootDir, app.id).catch((err) => {
      console.warn(
        `[AppService] Failed to write metadata.json for ${app.id}:`,
        (err as Error).message,
      );
    });

    if (!hasBackendFiles(files)) {
      await this.scaffoldAppBackend(appPath);
    }

    return app;
  }

  /**
   * Create default backend/manifest.json + ping handler for new apps.
   * Server code lives under backend/ (not bundled into the browser).
   */
  private async scaffoldAppBackend(appPath: string): Promise<void> {
    const backendDir = path.join(appPath, BACKEND_FOLDER);
    const manifestPath = path.join(backendDir, "manifest.json");
    try {
      await fs.access(manifestPath);
      return;
    } catch {
      /* create scaffold */
    }

    await fs.mkdir(backendDir, { recursive: true });
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(backendDir, "ping.py"),
      DEFAULT_BACKEND_PING_HANDLER,
      "utf8",
    );
    const dbHelperSrc = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "appRuntime",
      "backendDbHelper.py",
    );
    await fs.copyFile(dbHelperSrc, path.join(backendDir, "papr_db.py"));
    console.log(`[AppService] Scaffolded ${BACKEND_FOLDER}/ for ${path.basename(appPath)}`);
  }

  async getApp(id: string): Promise<MiniApp | null> {
    const app = this.apps.get(id);
    if (!app) {
      return null;
    }

    const hints = await readAppDiskOwnershipHints(
      path.join(this.appsDir, id),
      id,
    );
    if (!isAppOwnedByCurrentUser(app, hints)) {
      return null;
    }

    if (!app.agentChat?.enabled) {
      const hydration = await hydrateAppAgentChatFromDisk(
        this.paprRootDir,
        id,
        app.agentChat,
      );
      if (hydration.agentChat) {
        const hydrated = { ...app, agentChat: hydration.agentChat };
        this.apps.set(id, hydrated);
        void this.saveApps().catch(() => {});
        void writeCloudAppMetadataFile(this.paprRootDir, id).catch(() => {});
        return hydrated;
      }
    }

    return app;
  }

  /**
   * Persist embedded app-agent chat (enable_app_agent_chat entry point).
   * Writes agent-chat.json sidecar, registry, and metadata.json in one flow.
   */
  async setAppAgentChat(
    appId: string,
    agentChat: AppAgentChatConfig | undefined,
  ): Promise<MiniApp | null> {
    const app = await this.getApp(appId);
    if (!app) return null;

    await writeAgentChatSidecar(this.paprRootDir, appId, agentChat);

    const updated = await this.updateApp(appId, { agentChat });
    if (!updated) return null;

    await writeCloudAppMetadataFile(this.paprRootDir, appId).catch((err) => {
      console.warn(
        `[AppService] Failed to write metadata.json after setAppAgentChat for ${appId}:`,
        (err as Error).message,
      );
    });

    return updated;
  }

  async updateApp(
    id: string,
    updates: Partial<Omit<MiniApp, "id" | "type" | "createdAt">>,
  ): Promise<MiniApp | null> {
    const app = await this.getApp(id);
    if (!app) return null;

    let nextUpdates = updates;
    if (updates.icon !== undefined && updates.icon.trim()) {
      const sanitizedIcon = sanitizeMiniAppIcon(updates.icon);
      if (!sanitizedIcon) {
        const iconResult = validateMiniAppIcon(updates.icon);
        console.warn(
          `[AppService] Ignoring invalid icon update for ${id}` +
            (iconResult.ok ? "" : `: ${iconResult.message}`),
        );
        const { icon: _dropped, ...withoutIcon } = nextUpdates;
        nextUpdates = withoutIcon;
      } else if (sanitizedIcon !== updates.icon.trim()) {
        nextUpdates = { ...nextUpdates, icon: sanitizedIcon };
      }
    }
    if (updates.title !== undefined) {
      const { ensureUniqueAppTitle } = await import("../utils/uniqueAppNaming.js");
      const uniqueTitle = ensureUniqueAppTitle(
        updates.title,
        [...this.apps.values()].map((existing) => existing.title),
        { excludeTitle: app.title },
      );
      if (uniqueTitle !== updates.title.trim()) {
        console.log(
          `[AppService] Renamed duplicate app title ${JSON.stringify(updates.title)} → ${JSON.stringify(uniqueTitle)}`,
        );
      }
      nextUpdates = { ...updates, title: uniqueTitle };
    }

    const updatedApp: MiniApp = {
      ...app,
      ...nextUpdates,
      updatedAt: new Date().toISOString(),
    };

    this.apps.set(id, updatedApp);
    await this.saveApps();

    if ("agentChat" in nextUpdates) {
      await writeAgentChatSidecar(this.paprRootDir, id, updatedApp.agentChat);
    }

    import("./gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_app_edited", {
        app_id: id,
        app_name: updatedApp.title.length > 80 ? `${updatedApp.title.slice(0, 79)}…` : updatedApp.title,
      });
    }).catch(() => {});

    console.log(`[AppService] Updated app: ${id}`);

    void writeCloudAppMetadataFile(this.paprRootDir, id).catch((err) => {
      console.warn(
        `[AppService] Failed to write metadata.json for ${id}:`,
        (err as Error).message,
      );
    });

    return updatedApp;
  }

  async deleteApp(id: string, options?: DeleteAppOptions): Promise<DeleteAppResult> {
    const app = await this.getApp(id);
    if (!app) {
      return { deleted: false };
    }

    let cloudStatus: { published: boolean; shareUrl: string | null } = {
      published: false,
      shareUrl: null,
    };
    try {
      const { getCloudAppPublishService } = await import(
        "./CloudAppPublishService.js"
      );
      cloudStatus = await getCloudAppPublishService().getCloudPublishStatus(id);
    } catch (error) {
      console.warn(
        `[AppService] Could not check cloud publish status for ${id}:`,
        (error as Error).message.slice(0, 120),
      );
    }

    if (cloudStatus.published && options?.unpublishFromCloud !== true) {
      return {
        deleted: false,
        requiresUnpublishConfirm: true,
        shareUrl: cloudStatus.shareUrl,
        appTitle: app.title,
      };
    }

    let unpublished = false;
    if (cloudStatus.published && options?.unpublishFromCloud === true) {
      const { getCloudAppPublishService } = await import(
        "./CloudAppPublishService.js"
      );
      await getCloudAppPublishService().unpublishApp(id);
      unpublished = true;
    }

    const { removeAppPublishPrefs } = await import("./cloudPublishPrefs.js");
    removeAppPublishPrefs(id, this.paprRootDir);

    // Stop watching the app directory
    this.unwatchApp(id);

    // Delete app directory
    const appPath = path.join(this.appsDir, id);
    try {
      await fs.rm(appPath, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[AppService] Failed to delete app directory: ${id}`,
        error,
      );
    }

    this.apps.delete(id);
    await this.saveApps();

    this.broadcastAppListUpdated();

    import("./gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_app_deleted", {
        app_id: id,
        app_name: app.title.length > 80 ? `${app.title.slice(0, 79)}…` : app.title,
      });
    }).catch(() => {});

    console.log(`[AppService] Deleted app: ${id}`);
    return { deleted: true, unpublished };
  }

  /**
   * Copy app bundle (linked jobs + DB registry) into another namespace.
   * Source is unchanged — delete locally if you no longer want it there.
   */
  async copyAppToNamespace(
    appId: string,
    targetOrganizationId: string,
    targetNamespaceId: string,
  ): Promise<CopyAppToNamespaceResult> {
    await this.initialize();
    const app = await this.getApp(appId);
    if (!app) {
      throw new CopyAppError("app_not_found", "App not found");
    }

    const result = await copyAppToNamespaceCore({
      appId,
      targetOrganizationId,
      targetNamespaceId,
      sourcePaprHome: this.paprRootDir,
    });

    console.log(
      `[AppService] Copied app ${appId} to namespace ${targetNamespaceId} ` +
        `(${result.copiedJobIds.length} job(s), ${result.skippedJobIds.length} already in target)`,
    );

    return result;
  }

  /**
   * True if ~/Papr/apps/{id} exists and has at least one entry (matches rebuild-index rules).
   */
  private async appDirHasContent(appId: string): Promise<boolean> {
    const appPath = path.join(this.appsDir, appId);
    try {
      const stat = await fs.stat(appPath);
      if (!stat.isDirectory()) return false;
      const files = await fs.readdir(appPath);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Remove registry entries when the app folder is missing or empty (e.g. agent used `rm -rf` instead of delete_app).
   * Persists apps.json and optionally notifies clients.
   */
  private async pruneStaleAppEntries(): Promise<boolean> {
    const currentRoot = this.paprRootDir;
    if (this.loadedPaprRoot && currentRoot !== this.loadedPaprRoot) {
      console.warn(
        `[AppService] Skipping stale-app prune — PAPR_HOME changed (${this.loadedPaprRoot} → ${currentRoot})`,
      );
      return false;
    }

    const staleIds: string[] = [];
    for (const id of this.apps.keys()) {
      if (!(await this.appDirHasContent(id))) {
        staleIds.push(id);
      }
    }
    if (staleIds.length === 0) return false;

    for (const id of staleIds) {
      this.unwatchApp(id);
      this.apps.delete(id);
      console.log(
        `[AppService] Pruned stale app index entry (folder missing or empty): ${id}`,
      );
    }
    await this.saveApps();
    this.broadcastAppListUpdated();
    return true;
  }

  private broadcastAppListUpdated(): void {
    import("../websocket/index.js")
      .then(({ broadcast }) => {
        if (typeof broadcast !== "function") return;
        broadcast({ type: "app:list-updated" });
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  async listApps(): Promise<MiniApp[]> {
    await this.initialize();

    // Prune here, not only at startup. initialize() early-returns once it has
    // run, so a folder removed after boot (agent `rm -rf`, external delete,
    // failed sync) stayed listed until the app restarted — the user clicks a
    // mini-app that no longer exists. listApps is the read path where that
    // ghost entry surfaces, so it is where the index gets reconciled.
    await this.pruneStaleAppEntries();

    const activeScope = readActiveAppWorkspaceScope();
    const owned: MiniApp[] = [];
    for (const app of this.apps.values()) {
      const needsDiskOwnership = !app.ownerUserId?.trim();
      const needsDiskWorkspace =
        !app.organizationId?.trim() || !app.namespaceId?.trim();

      const appDir = path.join(this.appsDir, app.id);
      const hints = needsDiskOwnership
        ? await readAppDiskOwnershipHints(appDir, app.id)
        : undefined;
      if (!isAppOwnedByCurrentUser(app, hints)) {
        continue;
      }

      const merged = needsDiskWorkspace
        ? {
            ...app,
            ...mergeAppWorkspaceFields(
              app,
              await readAppWorkspaceFieldsFromDisk(appDir),
            ),
          }
        : app;

      if (!shouldShowAppInMyApps(app.id, merged, activeScope)) {
        continue;
      }

      owned.push(merged);
    }

    return owned.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /** Apps on disk in this namespace with no workspace assignment (org/namespace missing). */
  async listUnassignedApps(): Promise<MiniApp[]> {
    await this.initialize();

    const activeScope = readActiveAppWorkspaceScope();
    if (!activeScope) {
      return [];
    }

    const unassigned: MiniApp[] = [];
    for (const app of this.apps.values()) {
      if (!(await this.appDirHasContent(app.id))) {
        continue;
      }

      const appDir = path.join(this.appsDir, app.id);
      const hints = await readAppDiskOwnershipHints(appDir, app.id);
      if (!isAppOwnedByCurrentUser(app, hints)) {
        continue;
      }

      const merged = {
        ...app,
        ...mergeAppWorkspaceFields(app, await readAppWorkspaceFieldsFromDisk(appDir)),
      };

      if (!isAppAwaitingAssignmentInWorkspace(app.id, merged, activeScope)) {
        continue;
      }

      unassigned.push(merged);
    }

    return unassigned.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async assignAppToWorkspace(
    appId: string,
    targetOrganizationId: string,
    targetNamespaceId: string,
  ): Promise<AssignAppToWorkspaceResult> {
    await this.initialize();
    const app = this.apps.get(appId);
    if (!app) {
      throw new AppWorkspaceAssignError("app_not_found", "App not found");
    }

    const appDir = path.join(this.appsDir, appId);
    const hints = await readAppDiskOwnershipHints(appDir, appId);
    if (!isAppOwnedByCurrentUser(app, hints)) {
      throw new AppWorkspaceAssignError("not_owner", "App is not owned by the signed-in user");
    }

    const merged = {
      ...app,
      ...mergeAppWorkspaceFields(app, await readAppWorkspaceFieldsFromDisk(appDir)),
    };

    const result = await assignAppToWorkspaceCore({
      appId,
      targetOrganizationId,
      targetNamespaceId,
      sourcePaprHome: this.paprRootDir,
      sourceApp: merged,
    });

    const activeScope = readActiveAppWorkspaceScope();
    const assignedHere =
      activeScope &&
      activeScope.organizationId === targetOrganizationId &&
      activeScope.namespaceId === targetNamespaceId;

    if (assignedHere) {
      const scoped = withWorkspaceScope(merged, {
        organizationId: targetOrganizationId,
        namespaceId: targetNamespaceId,
      });
      scoped.updatedAt = new Date().toISOString();
      this.apps.set(appId, scoped);
      await this.saveApps();
      void this.autoDiscoverDataSources(appId).catch((err) => {
        console.warn(
          `[AppService] Code-based data source discovery failed for ${appId}:`,
          err,
        );
      });
    } else {
      this.unwatchApp(appId);
      this.apps.delete(appId);
      await this.saveApps();
    }

    this.broadcastAppListUpdated();

    return result;
  }

  async resolveAppFilePath(
    appId: string,
    filename: string,
  ): Promise<string | null> {
    const app = await this.getApp(appId);
    if (!app) return null;

    const filePath = path.join(this.appsDir, appId, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  async readAppFile(appId: string, filename: string): Promise<string | null> {
    const filePath = await this.resolveAppFilePath(appId, filename);
    if (!filePath) return null;

    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      console.error(`[AppService] Failed to read file: ${filename}`, error);
      return null;
    }
  }

  /** Recursive source file listing (excludes dist/, backend/, node_modules). */
  async listAppFiles(appId: string): Promise<string[]> {
    const app = await this.getApp(appId);
    if (!app) return [];

    const appPath = path.join(this.appsDir, appId);
    const absoluteFiles = await this.getAllAppFiles(appPath);
    return absoluteFiles
      .map((file) => path.relative(appPath, file))
      .sort((a, b) => a.localeCompare(b));
  }

  /** backend/ manifest + handlers (excluded from listAppFiles browser bundle listing). */
  async listAppBackendFiles(appId: string): Promise<string[]> {
    const app = await this.getApp(appId);
    if (!app) return [];

    const backendDir = path.join(this.appsDir, appId, "backend");
    try {
      const entries = await fs.readdir(backendDir);
      return entries
        .filter((name) => !name.startsWith("."))
        .map((name) => `backend/${name}`)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * Atomic read-modify-write for app files. Serializes concurrent edits to the
   * same file so parallel tool calls cannot overwrite each other.
   */
  async updateAppFile(
    appId: string,
    filename: string,
    updater: (content: string) => string,
  ): Promise<{ content: string; written: boolean } | null> {
    const lockKey = `app:${appId}:${filename}`;
    return withFileEditLock(lockKey, async () => {
      const content = await this.readAppFile(appId, filename);
      if (content === null) return null;

      const newContent = updater(content);
      if (newContent === content) {
        return { content, written: false };
      }

      const written = await this.writeAppFile(appId, filename, newContent);
      if (!written) return null;
      return { content: newContent, written: true };
    });
  }

  async writeAppFile(
    appId: string,
    filename: string,
    content: string,
  ): Promise<boolean> {
    const app = await this.getApp(appId);
    if (!app) return false;

    const filePath = path.join(this.appsDir, appId, filename);
    try {
      // Save a version of the current file before overwriting
      try {
        const existing = await fs.readFile(filePath, "utf-8");
        await this.saveFileVersion(appId, filename, existing, "auto");
      } catch {
        // File doesn't exist yet (first write) — no version to save
      }

      // Ensure parent directories exist (for components/foo.ts, utils/bar.ts, etc.)
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      // Flush to disk immediately to prevent race conditions
      await fs.writeFile(filePath, content, { flush: true });

      if (filename.replace(/\\/g, "/").startsWith("backend/")) {
        try {
          const { syncBackendManifestVaultKeys } = await import(
            "../utils/backendManifestKeySync.js"
          );
          const syncResult = await syncBackendManifestVaultKeys(
            path.join(this.appsDir, appId),
            filename,
            content,
          );
          if (syncResult.updated) {
            console.log(
              `[AppService] Auto-synced backend manifest keys for ${appId}/${filename}: ` +
                `${syncResult.addedKeys.join(", ")} on action(s) ${syncResult.actionNames.join(", ")}`,
            );
            try {
              const { ensureAppRequirementsSyncedWithBackend } = await import(
                "./cloudAppRequirements.js"
              );
              await ensureAppRequirementsSyncedWithBackend(
                this.paprRootDir,
                appId,
              );
            } catch (reqSyncError) {
              console.warn(
                `[AppService] requirements.json sync after manifest keys failed for ${appId}:`,
                reqSyncError,
              );
            }
          }
        } catch (syncError) {
          console.warn(
            `[AppService] Backend manifest key auto-sync failed for ${appId}/${filename}:`,
            syncError,
          );
        }
      }

      // Sync icon to registry when icon-bearing files are written
      const basename = path.basename(filename);
      if (basename === "index.html") {
        const extracted = this.extractFaviconFromHTML(content);
        if (extracted && extracted !== app.icon) {
          app.icon = extracted;
        }
      } else if (["logo.svg", "icon.svg", "favicon.svg"].includes(basename)) {
        const trimmed = content.trim();
        if (trimmed.startsWith("<svg") && trimmed.includes("</svg>")) {
          let svg = trimmed.replace(/"/g, "'");
          svg = svg
            .replace(/width=['"][^'"]*['"]/i, "width='14'")
            .replace(/height=['"][^'"]*['"]/i, "height='14'");
          if (!svg.includes("width=")) {
            svg = svg.replace("<svg", "<svg width='14' height='14'");
          }
          if (svg !== app.icon) {
            app.icon = svg;
          }
        }
      }

      // Update app's updatedAt
      app.updatedAt = new Date().toISOString();
      await this.saveApps();

      // Rebuild + iframe reload are handled by the filesystem watcher (debounced)
      // so multi-file agent edits coalesce into a single build/reload cycle.

      return true;
    } catch (error) {
      console.error(`[AppService] Failed to write file: ${filename}`, error);
      return false;
    }
  }

  /**
   * Run esbuild.build() on a bundled mini-app. Returns structured build errors
   * that replace regex-based CSS validation. For legacy apps (no ES module entry),
   * returns success with legacy flag — they still use per-file transpilation.
   */
  async buildApp(appId: string): Promise<MiniAppBuildResult> {
    const inFlight = this.buildInFlight.get(appId);
    if (inFlight) {
      return inFlight;
    }

    const run = (async (): Promise<MiniAppBuildResult> => {
      const app = this.apps.get(appId);
      if (!app) {
        return {
          success: false,
          errors: [
            {
              file: "app",
              message: `App not found: ${appId}`,
              severity: "error",
            },
          ],
          outputFiles: [],
          legacy: false,
        };
      }
      const appDir = path.join(this.appsDir, appId);
      const result = await buildMiniApp(appDir);
      this.lastBuildResult.set(appId, result);

      if (!result.legacy) {
        const status = result.success
          ? `✓ Build passed (${result.outputFiles.length} output files)`
          : `✗ Build failed (${result.errors.filter((e) => e.severity === "error").length} errors)`;
        console.log(`[AppService] Build ${appId}: ${status}`);
      }

      return result;
    })();

    this.buildInFlight.set(appId, run);
    try {
      return await run;
    } finally {
      if (this.buildInFlight.get(appId) === run) {
        this.buildInFlight.delete(appId);
      }
    }
  }

  /**
   * Get the cached build result for an app (from last buildApp call).
   */
  getLastBuildResult(appId: string): MiniAppBuildResult | undefined {
    return this.lastBuildResult.get(appId);
  }

  /**
   * Start watching all app directories for file changes
   */
  private async startWatchingApps(): Promise<void> {
    const appIds = [...this.apps.values()].map((app) => app.id);
    const batchSize = 16;
    for (let index = 0; index < appIds.length; index += batchSize) {
      const batch = appIds.slice(index, index + batchSize);
      await Promise.all(batch.map((appId) => this.watchApp(appId)));
    }
    console.log(`[AppService] Started watching ${this.watchers.size} app directories`);
  }

  /**
   * Watch a specific app directory for file changes
   */
  private async watchApp(appId: string): Promise<void> {
    if (this.disposed) return;
    const appPath = path.join(this.appsDir, appId);

    // Check if directory exists before watching
    try {
      await fs.access(appPath);
    } catch {
      return; // Directory doesn't exist yet
    }
    // Re-check after the await: cleanup() may have run while we were resolving.
    if (this.disposed) return;

    // Don't create duplicate watchers
    if (this.watchers.has(appId)) {
      return;
    }

    try {
      const watcher = chokidar.watch(appPath, {
        persistent: true,
        ignoreInitial: true,
        ignored: shouldIgnoreAppWatchPath,
        awaitWriteFinish: {
          stabilityThreshold: 200, // Wait 200ms after last change
          pollInterval: 100,
        },
      });

      watcher.on("change", (filePath) => {
        const filename = path.relative(appPath, filePath);
        this.handleFileChange(appId, filename);
      });

      watcher.on("add", (filePath) => {
        const filename = path.relative(appPath, filePath);
        this.handleFileChange(appId, filename);
      });

      watcher.on("error", (error) => {
        // Log the message, not the object. Watcher errors carry non-cloneable
        // fields (fs handles, syscall metadata); passing the raw object to a
        // reporter that serializes stdout across a process boundary throws
        // inside the serializer and takes down the whole run.
        console.error(
          `[AppService] Watcher error for app ${appId}:`,
          (error as Error)?.message ?? String(error),
        );
        this.watchers.delete(appId);
      });

      this.watchers.set(appId, watcher);
    } catch (error) {
      console.error(`[AppService] Failed to watch app ${appId}:`, error);
    }
  }

  /**
   * Stop watching a specific app directory
   */
  private unwatchApp(appId: string): void {
    const watcher = this.watchers.get(appId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(appId);
    }

    // Clear any pending debounce timers for this app
    for (const [key, timer] of this.debounceTimers.entries()) {
      if (key.startsWith(`${appId}:`)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }
  }

  /**
   * Handle file change detected by filesystem watcher
   */
  private handleFileChange(appId: string, filename: string): void {
    console.log(`[AppService] File changed on disk: ${appId}/${filename}`);

    // Skip rebuild for dist/ output files (avoids infinite loop)
    if (filename.startsWith("dist/") || filename.startsWith("dist\\")) {
      return;
    }

    // Debounce per app: agent edits often touch many files in one turn.
    // One rebuild + one reload after edits settle (avoids aborting in-flight DB fetches).
    if (this.debounceTimers.has(appId)) {
      clearTimeout(this.debounceTimers.get(appId)!);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(appId);
      void this.processFileChange(appId, filename);
    }, AppService.FILE_CHANGE_DEBOUNCE_MS);

    this.debounceTimers.set(appId, timer);
  }

  private async processFileChange(appId: string, filename: string): Promise<void> {
    try {
      await this.buildApp(appId);
      await this.runValidation(appId);
      this.scheduleReloadBroadcast(appId, filename);

      const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
      const coordinator = getSyncCoordinator();
      if (coordinator) {
        coordinator.markGitDirty(path.join("apps", appId));
      } else {
        const { getCloudSyncService } = await import("./CloudSyncService.js");
        getCloudSyncService()?.enqueueRelativePath(path.join("apps", appId));
      }
    } catch (error) {
      console.error(`[AppService] Build/validation error for app ${appId}:`, error);
      // Still broadcast on error so UI shows the latest source/build state
      this.scheduleReloadBroadcast(appId, filename);
    }
  }

  /**
   * Debounce reload broadcasts so spaced-out agent edits (e.g. file at T=0 and
   * T=2s) collapse into one iframe reload after the burst settles.
   */
  private scheduleReloadBroadcast(appId: string, filename: string): void {
    const existing = this.reloadBroadcastTimers.get(appId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.reloadBroadcastTimers.delete(appId);
      this.broadcastFileChange(appId, filename);
    }, AppService.RELOAD_BROADCAST_DEBOUNCE_MS);

    this.reloadBroadcastTimers.set(appId, timer);
  }

  /**
   * Validate an app's files (linting + LOC checks) - Public API
   */
  async validateApp(appId: string): Promise<ValidationResult> {
    // Always rebuild first — validation reads lastBuildResult; stale cache hid compile failures.
    await this.buildApp(appId);
    return await this.runValidation(appId);
  }

  /**
   * Internal validation implementation
   */
  private async runValidation(appId: string): Promise<ValidationResult> {
    const app = this.apps.get(appId);
    if (!app) {
      return {
        appId,
        timestamp: new Date().toISOString(),
        valid: false,
        issues: [{
          file: 'app',
          severity: 'error',
          message: `App not found: ${appId}`,
        }],
        filesChecked: 0,
      };
    }

    const appPath = path.join(this.appsDir, appId);
    const issues: ValidationIssue[] = [];
    const filesToCheck: string[] = [];

    if (app.icon) {
      const { validateMiniAppIcon } = await import(
        "../../core/utils/miniAppIconValidation.js"
      );
      const iconResult = validateMiniAppIcon(app.icon);
      if (!iconResult.ok) {
        issues.push({
          file: "app",
          severity: "warning",
          rule: iconResult.rule,
          message: iconResult.message,
        });
      }
    }

    // Find all files to validate
    try {
      const files = await this.getAllAppFiles(appPath);
      filesToCheck.push(...files);
    } catch (error) {
      console.error(`[AppService] Failed to list app files:`, error);
      return {
        appId,
        timestamp: new Date().toISOString(),
        valid: false,
        issues: [{
          file: 'app',
          severity: 'error',
          message: `Failed to read app files: ${(error as Error).message}`,
        }],
        filesChecked: 0,
      };
    }

    const fileContents = new Map<string, string>();

    // Use esbuild build result for bundled apps — catches CSS import errors,
    // missing files, and syntax issues the same way an IDE bundler would.
    const buildResult = this.lastBuildResult.get(appId);
    const isBundledApp = buildResult !== undefined && !buildResult.legacy;

    if (isBundledApp) {
      for (const buildError of buildResult.errors) {
        issues.push({
          file: buildError.file,
          line: buildError.line,
          column: buildError.column,
          severity: buildError.severity,
          message: buildError.message,
          rule: "esbuild",
        });
      }
    }

    // Check each file
    for (const file of filesToCheck) {
      const relativePath = path.relative(appPath, file);
      const ext = path.extname(file).toLowerCase();

      // Skip content assets (.md reports, .json data, etc.) and build output
      if (AppService.MINI_APP_CONTENT_EXTENSIONS.has(ext)) {
        continue;
      }
      if (!AppService.MINI_APP_LOC_CHECK_EXTENSIONS.has(ext)) {
        continue;
      }
      if (relativePath.startsWith("dist/") || relativePath.startsWith("dist\\")) {
        continue;
      }

      try {
        const content = await fs.readFile(file, 'utf-8');
        fileContents.set(relativePath, content);

        // LOC check (100 lines max for code — not .md/.json content assets)
        const basename = path.basename(relativePath);
        const locIssues = AppService.MINI_APP_LOC_EXEMPT_BASENAMES.has(basename)
          ? []
          : this.checkLineLimit(content, relativePath, 100);
        issues.push(...locIssues);

        // HTML checks always run
        if (ext === '.html') {
          const htmlIssues = this.checkHtmlSyntax(content, relativePath);
          issues.push(...htmlIssues);
        }

        // For bundled apps, esbuild already validates CSS and TS syntax
        // — skip redundant per-file checks. For legacy apps, keep them.
        if (!isBundledApp) {
          if (ext === '.css') {
            const cssIssues = this.checkCssSyntax(content, relativePath);
            issues.push(...cssIssues);
          } else if (ext === '.js' || ext === '.jsx') {
            // esbuild-based syntax check (string/comment-aware)
            const jsIssues = await this.checkJavaScriptSyntax(content, relativePath);
            issues.push(...jsIssues);
          } else if (ext === '.ts' || ext === '.tsx') {
            // esbuild transpile validates syntax for TS — no separate pass needed
            const transpileIssues = await this.checkTypeScriptTranspile(
              content,
              relativePath,
            );
            issues.push(...transpileIssues);
            issues.push(...this.checkNoConsole(content, relativePath));
          }
        }
      } catch (error) {
        console.error(`[AppService] Failed to validate ${relativePath}:`, error);
      }
    }

    issues.push(...this.checkMiniAppRuntimePatterns(fileContents));
    try {
      const { checkMiniAppBashPatterns, checkBackendManifestIntegrity, checkOrphanBackendHandlers } =
        await import("../utils/miniAppBackendLint.js");
      issues.push(...checkMiniAppBashPatterns(fileContents));
      issues.push(...(await checkBackendManifestIntegrity(appPath)));
      issues.push(...(await checkOrphanBackendHandlers(appPath)));
    } catch (lintError) {
      console.warn("[AppService] Backend lint failed:", lintError);
    }
    try {
      const { checkMiniAppJobEventPatterns } = await import(
        "../utils/miniAppJobEventLint.js"
      );
      issues.push(...checkMiniAppJobEventPatterns(fileContents));
    } catch (lintError) {
      console.warn("[AppService] Job event lint failed:", lintError);
    }
    try {
      const { checkMiniAppEmojiPatterns } = await import(
        "../utils/miniAppEmojiLint.js"
      );
      issues.push(...checkMiniAppEmojiPatterns(fileContents));
    } catch (lintError) {
      console.warn("[AppService] Emoji lint failed:", lintError);
    }
    try {
      const { checkFrontendSqlOveruse } = await import(
        "../utils/miniAppFrontendSqlLint.js"
      );
      issues.push(...checkFrontendSqlOveruse(fileContents));
    } catch (lintError) {
      console.warn("[AppService] Frontend SQL lint failed:", lintError);
    }
    try {
      const {
        scanMiniAppCloudCompatibility,
        buildCloudCompatibilityReport,
      } = await import("../utils/miniAppCloudCompatibility.js");
      const dataSourcesRaw = fileContents.get("data-sources.json");
      const cloudReport = buildCloudCompatibilityReport(
        scanMiniAppCloudCompatibility(fileContents, dataSourcesRaw),
      );
      for (const finding of cloudReport.findings) {
        if (finding.severity === "info") continue;
        issues.push({
          file: finding.file,
          line: finding.line,
          severity: "warning",
          message: `[Cloud ${cloudReport.level}] ${finding.message}`,
          rule: `cloud-compatibility-${finding.category}`,
        });
      }
    } catch (lintError) {
      console.warn("[AppService] Cloud compatibility lint failed:", lintError);
    }
    issues.push(...(await this.checkLinkedDataSources(appId, fileContents)));

    // Startup health: heavy eager import graphs, render-blocking CSS count,
    // selector drift, and stale dist bundles (all warnings; stale-missing
    // bundle is an error since the app cannot boot at all).
    try {
      const { checkMiniAppStartupHealth, checkStaleBundle } = await import(
        "../utils/miniAppStartupHealth.js"
      );
      issues.push(...checkMiniAppStartupHealth(fileContents));

      const indexHtmlContent = fileContents.get("index.html");
      if (indexHtmlContent && /src=["'][^"']*dist\//.test(indexHtmlContent)) {
        let distMtimeMs: number | null = null;
        let newestSourceMtimeMs: number | null = null;
        // Read dist/ files directly (getAllAppFiles skips dist/)
        const distDir = path.join(appPath, "dist");
        try {
          const distEntries = await fs.readdir(distDir);
          for (const df of distEntries) {
            try {
              const stat = await fs.stat(path.join(distDir, df));
              distMtimeMs = Math.max(distMtimeMs ?? 0, stat.mtimeMs);
            } catch { /* skip */ }
          }
        } catch { /* no dist dir */ }
        for (const file of filesToCheck) {
          const rel = path.relative(appPath, file);
          try {
            const stat = await fs.stat(file);
            if (/\.(ts|tsx|js|jsx|css|html)$/.test(rel)) {
              newestSourceMtimeMs = Math.max(newestSourceMtimeMs ?? 0, stat.mtimeMs);
            }
          } catch {
            // ignore unreadable files
          }
        }
        issues.push(
          ...checkStaleBundle(indexHtmlContent, distMtimeMs, newestSourceMtimeMs),
        );
      }
    } catch (healthError) {
      console.warn("[AppService] Startup health checks failed:", healthError);
    }

    // Broadcast validation result
    const result: ValidationResult = {
      appId,
      timestamp: new Date().toISOString(),
      valid: !issues.some((issue) => issue.severity === "error"),
      issues,
      filesChecked: filesToCheck.length,
    };

    this.broadcastValidation(result);
    return result;
  }

  /**
   * Get all files in app directory recursively
   */
  private async getAllAppFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Skip hidden files, versions, node_modules, build output, and server backend
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "backend"
        ) {
          continue;
        }
        
        if (entry.isDirectory()) {
          const subFiles = await this.getAllAppFiles(fullPath);
          files.push(...subFiles);
        } else {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory doesn't exist or permission error
    }
    
    return files;
  }

  /**
   * Check if file exceeds line limit
   */
  private checkLineLimit(
    content: string,
    filename: string,
    maxLines: number,
  ): ValidationIssue[] {
    const lines = content.split('\n');
    let significantLines = 0;
    let inBlockComment = false;

    // Count significant lines (exclude empty lines and comments)
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (!trimmed) continue;
      
      // Handle block comments
      if (trimmed.startsWith('/*')) {
        inBlockComment = true;
      }
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      
      // Skip single-line comments
      if (trimmed.startsWith('//')) continue;
      
      significantLines++;
    }

    if (significantLines > maxLines) {
      const excess = significantLines - maxLines;
      return [{
        file: filename,
        severity: 'warning',
        message: `File has ${significantLines} lines (${excess} over the ${maxLines} line limit). Break into smaller components.`,
        rule: 'max-lines',
      }];
    }

    return [];
  }

  /**
   * Block apps that call /api/db/* without a linked job database.
   */
  private async checkLinkedDataSources(
    appId: string,
    fileContents: Map<string, string>,
  ): Promise<ValidationIssue[]> {
    const {
      appFilesUseDatabaseApi,
      buildMissingDataSourceValidationIssue,
      checkDbQueryWriteAntiPattern,
      checkMissingTablesOnPrimaryDb,
    } = await import("./appDatabaseEnforcement.js");

    const issues: ValidationIssue[] = [];
    issues.push(...checkDbQueryWriteAntiPattern(fileContents));

    if (!appFilesUseDatabaseApi(fileContents)) {
      return issues;
    }

    const config = await this.getDataSourcesConfig(appId);
    if (config.sources.length === 0) {
      issues.push(buildMissingDataSourceValidationIssue(appId));
      return issues;
    }

    const primary = await this.getPrimaryDataSource(appId);
    if (primary?.dbPath) {
      issues.push(
        ...checkMissingTablesOnPrimaryDb(primary.dbPath, fileContents),
      );
    }

    return issues;
  }

  /**
   * Cross-file checks that affect what users see in the iframe (not just DOM text).
   */
  private checkMiniAppRuntimePatterns(
    fileContents: Map<string, string>,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const allContent = Array.from(fileContents.values()).join("\n");
    const cssContent = Array.from(fileContents.entries())
      .filter(([name]) => name.endsWith(".css"))
      .map(([, content]) => content)
      .join("\n");

    const usesHiddenClass =
      /class=["'][^"']*\bhidden\b/.test(allContent) ||
      /\.classList\.(add|remove|toggle)\(['"]hidden['"]\)/.test(allContent);

    const definesHiddenRule = /\.hidden\s*\{/.test(cssContent);

    if (usesHiddenClass && !definesHiddenRule) {
      issues.push({
        file: "app",
        severity: "error",
        message:
          'Uses class "hidden" but no .hidden { display: none } rule in any CSS file — modals/overlays stay visible and block the UI with blur',
        rule: "css-hidden-utility",
      });
    }

    for (const [filename, content] of fileContents.entries()) {
      if (!filename.endsWith(".css")) {
        continue;
      }
      if (/@import\s+url\(['"]https?:\/\/fonts\.googleapis\.com/.test(content)) {
        issues.push({
          file: filename,
          severity: "warning",
          message:
            "Google Fonts @import in CSS can stall rendering in iframe — use <link rel=\"stylesheet\" href=\"...\"> in index.html instead",
          rule: "css-font-import",
        });
      }
    }

    const jsTsContent = Array.from(fileContents.entries())
      .filter(([name]) => /\.(js|ts|tsx|jsx)$/.test(name))
      .map(([, content]) => content)
      .join("\n");
    if (
      /fetch\s*\(\s*['"]https?:\/\/(?!localhost|127\.0\.0\.1)/.test(jsTsContent)
    ) {
      issues.push({
        file: "app",
        severity: "warning",
        message:
          "Direct external fetch() from mini-app client — use /api/app/backend/:action, /api/jobs/run, or /api/db/* so preview matches cloud",
        rule: "external-fetch",
      });
    }

    return issues;
  }

  /**
   * Basic HTML syntax validation
   */
  private checkHtmlSyntax(content: string, filename: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lines = content.split('\n');

    // Check for unclosed tags (basic validation)
    const tagStack: Array<{ tag: string; line: number }> = [];
    const selfClosing = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Find opening tags
      const openingTags = line.matchAll(/<(\w+)[^>]*>/g);
      for (const match of openingTags) {
        const tag = match[1].toLowerCase();
        if (!selfClosing.has(tag) && !line.includes(`</${tag}>`)) {
          tagStack.push({ tag, line: i + 1 });
        }
      }
      
      // Find closing tags
      const closingTags = line.matchAll(/<\/(\w+)>/g);
      for (const match of closingTags) {
        const tag = match[1].toLowerCase();
        if (tagStack.length > 0 && tagStack[tagStack.length - 1].tag === tag) {
          tagStack.pop();
        }
      }
    }

    // Report unclosed tags
    for (const { tag, line } of tagStack) {
      issues.push({
        file: filename,
        line,
        severity: 'warning',
        message: `Potentially unclosed <${tag}> tag`,
        rule: 'html-syntax',
      });
    }

    return issues;
  }

  /**
   * Basic CSS syntax validation
   */
  private checkCssSyntax(content: string, filename: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lines = content.split('\n');

    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Count braces
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      
      // Check for common errors
      if (line.includes(';;')) {
        issues.push({
          file: filename,
          line: i + 1,
          severity: 'warning',
          message: 'Double semicolon found',
          rule: 'css-syntax',
        });
      }
    }

    if (braceCount !== 0) {
      issues.push({
        file: filename,
        severity: 'error',
        message: `Mismatched braces (${braceCount > 0 ? 'missing closing' : 'extra closing'} braces)`,
        rule: 'css-syntax',
      });
    }

    return issues;
  }

  /**
   * Basic JavaScript/TypeScript syntax validation
   */
  private async checkTypeScriptTranspile(
    content: string,
    filename: string,
  ): Promise<ValidationIssue[]> {
    const { transpileMiniAppTypeScript } = await import(
      "../utils/miniAppTranspile.js"
    );
    const result = await transpileMiniAppTypeScript(content, filename);
    if (result.success) {
      return [];
    }

    const location =
      result.line !== undefined
        ? ` (line ${result.line}${result.column !== undefined ? `, col ${result.column}` : ""})`
        : "";

    return [
      {
        file: filename,
        line: result.line,
        column: result.column,
        severity: "error",
        message: `TypeScript build failed${location}: ${result.message ?? "Unknown transpile error"}`,
        rule: "transpile",
      },
    ];
  }

  /**
   * JavaScript/TypeScript syntax validation via esbuild (string/comment-aware).
   * Replaces the old naive delimiter counting, which produced false
   * "mismatched parentheses" errors on literals like indexOf('(').
   * Non-syntax lint (console.log) is kept as a line-based warning pass.
   */
  private async checkJavaScriptSyntax(
    content: string,
    filename: string,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    const { validateMiniAppScriptSyntax } = await import(
      "../utils/miniAppTranspile.js"
    );
    const result = await validateMiniAppScriptSyntax(content, filename);
    if (!result.success) {
      const location =
        result.line !== undefined
          ? ` (line ${result.line}${result.column !== undefined ? `, col ${result.column}` : ""})`
          : "";
      issues.push({
        file: filename,
        line: result.line,
        column: result.column,
        severity: "error",
        message: `Syntax error${location}: ${result.message ?? "Unknown parse error"}`,
        rule: "syntax",
      });
    }

    issues.push(...this.checkNoConsole(content, filename));

    return issues;
  }

  private checkNoConsole(content: string, filename: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("console.log")) {
        issues.push({
          file: filename,
          line: i + 1,
          severity: "warning",
          message: "Remove console.log statements before production",
          rule: "no-console",
        });
      }
    }
    return issues;
  }

  /**
   * Broadcast validation result to all connected clients
   */
  private broadcastValidation(result: ValidationResult): void {
    if (result.issues.length > 0) {
      const errorCount = result.issues.filter((i) => i.severity === "error").length;
      const warningCount = result.issues.length - errorCount;
      console.log(
        `[AppService] Validation: app ${result.appId} — ${errorCount} error(s), ${warningCount} warning(s)`,
      );

      // Full per-issue lines are noisy when cloud sync touches many apps at once.
      // Agents can call validate_app for details; websocket still carries full results.
      if (process.env.PAPR_VERBOSE_APP_VALIDATION === "1") {
        for (const issue of result.issues) {
          const prefix = issue.severity === "error" ? "❌" : "⚠️";
          const location = issue.line ? `:${issue.line}` : "";
          console.log(`${prefix} ${issue.file}${location} - ${issue.message}`);
        }
      }
    }

    import("../websocket/index.js")
      .then(({ broadcast }) => {
        if (typeof broadcast !== "function") return;
        broadcast({
          type: "app:validation-result",
          data: result,
        });
      })
      .catch((error) => {
        console.warn(
          "[AppService] Failed to broadcast validation:",
          (error as Error)?.message ?? String(error),
        );
      });
  }

  /**
   * Broadcast app file change to all connected clients
   */
  private broadcastFileChange(appId: string, filename: string): void {
    import("../websocket/index.js")
      .then(({ broadcast }) => {
        if (typeof broadcast !== "function") return;
        broadcast({
          type: "app:file-changed",
          data: { appId, filename, timestamp: Date.now() },
        });
        console.log(
          `[AppService] Broadcasted file change: ${appId}/${filename}`,
        );
      })
      .catch((error) => {
        console.warn(
          "[AppService] Failed to broadcast file change:",
          (error as Error)?.message ?? String(error),
        );
        // Non-fatal - file was still written successfully
      });
  }

  // ===== File Version History =====

  private getVersionsDir(appId: string, filename: string): string {
    const safeFilename = filename.replace(/\//g, "__");
    return path.join(this.appsDir, appId, ".versions", safeFilename);
  }

  async saveFileVersion(
    appId: string,
    filename: string,
    content: string,
    reason: string = "auto",
  ): Promise<string> {
    const versionsDir = this.getVersionsDir(appId, filename);
    await fs.mkdir(versionsDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const versionId = `${safeTimestamp}_${reason}`;

    // Deduplicate: skip if latest version has identical content
    const existing = await this.getFileVersionHistory(appId, filename);
    if (existing.length > 0) {
      const latest = await this.getFileVersion(appId, filename, existing[0].versionId);
      if (latest && latest.content === content) {
        return existing[0].versionId;
      }
    }

    const versionPath = path.join(versionsDir, versionId);
    await fs.writeFile(versionPath, content, "utf-8");
    console.log(`[AppService] Saved version ${versionId} for ${appId}/${filename}`);
    return versionId;
  }

  async getFileVersionHistory(
    appId: string,
    filename: string,
  ): Promise<AppFileVersion[]> {
    const versionsDir = this.getVersionsDir(appId, filename);

    let files: string[];
    try {
      files = await fs.readdir(versionsDir);
    } catch {
      return [];
    }

    const versions: AppFileVersion[] = files
      .map((f) => {
        const firstUnderscore = f.indexOf("_");
        const reason = firstUnderscore >= 0 ? f.slice(firstUnderscore + 1) : "auto";
        return {
          versionId: f,
          filename,
          timestamp: versionIdToTimestamp(f),
          reason,
          preview: "",
        };
      })
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    // Load previews for first 20 versions
    for (const v of versions.slice(0, 20)) {
      try {
        const content = await fs.readFile(
          path.join(versionsDir, v.versionId),
          "utf-8",
        );
        v.preview = content.slice(0, 200);
      } catch {
        /* noop */
      }
    }

    return versions;
  }

  async getFileVersion(
    appId: string,
    filename: string,
    versionId: string,
  ): Promise<AppFileVersionFull | null> {
    const versionPath = path.join(
      this.getVersionsDir(appId, filename),
      versionId,
    );

    try {
      const content = await fs.readFile(versionPath, "utf-8");
      return {
        versionId,
        filename,
        timestamp: versionIdToTimestamp(versionId),
        reason: versionId.slice(versionId.indexOf("_") + 1) || "auto",
        preview: content.slice(0, 200),
        content,
      };
    } catch {
      return null;
    }
  }

  async restoreFileVersion(
    appId: string,
    filename: string,
    versionId: string,
  ): Promise<boolean> {
    const version = await this.getFileVersion(appId, filename, versionId);
    if (!version) return false;

    // Save current content as "before-restore" version first
    const filePath = path.join(this.appsDir, appId, filename);
    try {
      const currentContent = await fs.readFile(filePath, "utf-8");
      if (currentContent) {
        await this.saveFileVersion(appId, filename, currentContent, "before-restore");
      }
    } catch {
      /* file may not exist */
    }

    // Write the restored content (bypasses writeAppFile to avoid double-versioning)
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, version.content, { flush: true });

    const app = this.apps.get(appId);
    if (app) {
      app.updatedAt = new Date().toISOString();
      await this.saveApps();
    }

    console.log(`[AppService] Restored ${filename} to version ${versionId} for app ${appId}`);
    return true;
  }

  async getAppPath(appId: string): Promise<string | null> {
    const app = this.apps.get(appId);
    if (!app) return null;
    return path.join(this.appsDir, appId);
  }

  private getDataSourcesPath(appId: string): string {
    return path.join(this.appsDir, appId, "data-sources.json");
  }

  private async readDataSourcesConfigFromDisk(
    appId: string,
  ): Promise<AppDataSourcesFile> {
    const dataSourcesPath = this.getDataSourcesPath(appId);
    try {
      const raw = await fs.readFile(dataSourcesPath, "utf8");
      return parseDataSourcesFile(raw);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { sources: [] };
      }
      throw error;
    }
  }

  async getDataSourcesConfig(appId: string): Promise<AppDataSourcesFile> {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }
    const config = await this.readDataSourcesConfigFromDisk(appId);
    const workspaceConfig = resolveDataSourcesForWorkspace(
      config,
      getPaprJobsRoot(),
    );

    const { getDatabaseRegistryService } = await import(
      "./DatabaseRegistryService.js"
    );
    const {
      extractDatabaseSlugFromPath,
      resolveReadableRegistryDbPath,
      workspaceRegistryDbPath,
    } = await import("./resolveRegistryDbPath.js");
    const registry = getDatabaseRegistryService();
    const dataDir = getPaprDataDir();
    const jobsRoot = getPaprJobsRoot();

    return {
      ...workspaceConfig,
      sources: workspaceConfig.sources.map((source) => {
        const record = source.dbId ? registry.getById(source.dbId) : undefined;
        const resolved = resolveReadableRegistryDbPath({
          dbPath: source.dbPath,
          registryPath: record?.localPath,
          dataDir,
        });
        if (resolved) {
          return resolved !== source.dbPath ? { ...source, dbPath: resolved } : source;
        }

        if (source.jobId?.trim()) {
          const jobPath = path.join(jobsRoot, source.jobId, "data", "data.db");
          return source.dbPath?.trim() === jobPath
            ? source
            : { ...source, dbPath: jobPath };
        }

        const slug = extractDatabaseSlugFromPath(
          source.dbPath?.trim() || record?.localPath?.trim() || "",
        );
        if (slug) {
          const canonical = workspaceRegistryDbPath(slug, dataDir);
          return source.dbPath?.trim() === canonical
            ? source
            : { ...source, dbPath: canonical };
        }

        return source;
      }),
    };
  }

  async listAppDataSources(appId: string): Promise<AppDataSource[]> {
    const config = await this.getDataSourcesConfig(appId);
    return config.sources;
  }

  async listWorkspaceFiles(appId: string) {
    const { listAppWorkspaceFiles, listJobWorkspaceFiles } = await import(
      "./appWorkspaceFiles.js"
    );
    const { getJobsService } = await import("./JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    return listAppWorkspaceFiles({
      appId,
      appsDir: this.appsDir,
      getDataSources: (id) => this.getDataSourcesConfig(id),
      listJobFiles: async (jobId, jobName, alias) => {
        const job = await jobsService.getJob(jobId);
        if (!job) return null;
        const jobDir = await jobsService.getJobPath(jobId);
        if (!jobDir) return null;
        return listJobWorkspaceFiles(jobDir, jobId, job.name ?? jobName, alias);
      },
    });
  }

  async getPrimaryDataSource(appId: string): Promise<AppDataSource | undefined> {
    const { getLegacyDefaultSource } = await import("./appDataSources.js");
    const config = await this.getDataSourcesConfig(appId);
    return getLegacyDefaultSource(config);
  }

  private async writeDataSourcesConfig(
    appId: string,
    config: AppDataSourcesFile,
    previousSources?: AppDataSource[],
  ): Promise<void> {
    await fs.writeFile(
      this.getDataSourcesPath(appId),
      serializeDataSourcesFile(config),
      "utf8",
    );

    if (previousSources) {
      const normalizePath = (p: string) => path.normalize(p);
      const removedSources = previousSources.filter(
        (prev) =>
          !config.sources.some(
            (next) =>
              normalizePath(next.dbPath) === normalizePath(prev.dbPath) ||
              (next.dbId && prev.dbId && next.dbId === prev.dbId),
          ),
      );
      if (removedSources.length > 0) {
        void this.onDataSourcesUnlinked(removedSources);
      }
    }
  }

  /**
   * Unlinking an app from a database must NOT delete shared Turso replicas.
   * Only clear local sync state for the detached link.
   */
  private async onDataSourcesUnlinked(
    removedSources: AppDataSource[],
  ): Promise<void> {
    const { clearTursoPushState } = await import("./tursoSyncState.js");

    for (const source of removedSources) {
      const syncKey =
        source.dbId ??
        source.jobId ??
        path.normalize(source.dbPath);
      clearTursoPushState(syncKey);
      console.log(
        `[AppService] Cleared Turso sync state for unlinked source ${source.alias} (${syncKey})`,
      );
    }
  }

  async ensureAppDbTs(appId: string): Promise<void> {
    const app = this.apps.get(appId);
    if (!app) return;

    const config = await this.getDataSourcesConfig(appId);
    if (config.sources.length === 0) return;

    const appPath = path.join(this.appsDir, appId);
    const dbTsPath = path.join(appPath, "db.ts");
    const content = buildAppDbTsContent(
      appId,
      config.sources.map((s) => ({ alias: s.alias })),
    );

    try {
      await fs.access(dbTsPath);
      const existing = await fs.readFile(dbTsPath, "utf8");
      if (existing.includes("APP_ID") && existing.includes(appId) && existing === content) {
        return;
      }
    } catch {
      // create below
    }

    await fs.writeFile(dbTsPath, content, "utf8");
  }

  async linkAppDataSource(
    appId: string,
    source: Omit<AppDataSource, "linkedAt">,
  ): Promise<AppDataSource[]> {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    const config = await this.getDataSourcesConfig(appId);
    const previousSources = config.sources;

    const isUpdate = config.sources.some((entry) => entry.id === source.id);

    let dbPath = source.dbPath;
    let jobDirForScratch: string | undefined;

    if (source.jobId) {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      await jobsService.initialize();
      jobDirForScratch =
        (await jobsService.getJobPath(source.jobId)) ?? undefined;
      const workspaceDbPath = await jobsService.getJobDatabasePath(source.jobId);
      if (workspaceDbPath) {
        dbPath = workspaceDbPath;
      }
    }

    const willPromoteJobDb = Boolean(source.jobId);

    if (willPromoteJobDb) {
      const { isJobOwnedDatabasePath, promoteJobDatabaseToRegistry } =
        await import("./databasePromotion.js");
      if (isJobOwnedDatabasePath(dbPath)) {
        const promoted = await promoteJobDatabaseToRegistry({
          sourcePath: dbPath,
          label: source.alias || app.title,
          moveFromJobFolder: true,
          jobDirForScratchReset: jobDirForScratch,
        });
        dbPath = promoted.dbPath;
        console.log(
          `[AppService] Promoted job database → ${dbPath} (${promoted.dbId})`,
        );
      }
    }

    const { initializeDatabaseRegistry } = await import(
      "./DatabaseRegistryService.js"
    );
    const registry = await initializeDatabaseRegistry();
    const record = await registry.ensureForPath(dbPath, {
      label: source.alias,
      ownerJobId: source.jobId,
    });

    const linked: AppDataSource = {
      ...source,
      dbPath,
      dbId: record.dbId,
      linkedAt: new Date().toISOString(),
    };

    const nextSources = isUpdate
      ? config.sources.map((entry) =>
          entry.id === linked.id ? linked : entry,
        )
      : [...config.sources, linked];

    await this.writeDataSourcesConfig(
      appId,
      {
        sources: nextSources,
      },
      previousSources,
    );

    await this.ensureAppDbTs(appId);

    app.updatedAt = new Date().toISOString();
    this.apps.set(app.id, app);
    await this.saveApps();

    if (linked.jobId) {
      void import("./tursoPushScheduler.js")
        .then(({ scheduleTursoPushForJob }) =>
          scheduleTursoPushForJob(linked.jobId!, "completion", "completion"),
        )
        .catch(() => undefined);
    }
    void import("./TursoLinkedDbWatcher.js")
      .then(({ refreshTursoLinkedDbWatcher }) => refreshTursoLinkedDbWatcher())
      .catch(() => undefined);

    return nextSources;
  }

  /**
   * @deprecated Jobs no longer auto-link scratch data.db to apps. Use create_database + attach_database.
   */
  async autoLinkJobToApps(
    _jobId: string,
    _options?: { allowBaseline?: boolean },
  ): Promise<AppDataSource[]> {
    return [];
  }

  /**
   * Auto-discover and link data sources for an app by analyzing which databases
   * it actually uses. Scans app code for database paths and links the corresponding jobs.
   * 
   * This is more accurate than folder-name matching because it discovers:
   * 1. Databases explicitly referenced in app code
   * 2. Jobs whose databases are in ~/Papr/jobs/{jobId}/data/*.db
   * 
   * @param appId - App ID to discover sources for
   * @returns Array of newly linked data sources
   */
  async autoDiscoverDataSources(appId: string): Promise<AppDataSource[]> {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    const { getJobsService } = await import("./JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const allJobs = await jobsService.listJobs();
    const config = await this.getDataSourcesConfig(appId);
    const existingJobIds = new Set(
      config.sources
        .map((source) => source.jobId)
        .filter((jobId): jobId is string => Boolean(jobId)),
    );

    const augmentExisting =
      process.env.PAPR_AUTO_DISCOVER_DATA_SOURCES === "true";
    if (config.sources.length > 0 && !augmentExisting) {
      return [];
    }

    const appDir = path.join(this.appsDir, appId);
    const discovered = await scanAppCodeForJobDatabaseReferences({
      appDir,
      jobsRoot: getPaprJobsRoot(),
    });

    const newSources: AppDataSource[] = [];
    for (const reference of discovered) {
      if (existingJobIds.has(reference.jobId)) {
        continue;
      }

      const job = allJobs.find((entry) => entry.id === reference.jobId);
      if (!job) {
        continue;
      }

      if (dbHasOnlyBaselineTables(reference.dbPath)) {
        console.log(
          `[AppService] Skipping auto-link for ${job.name}: DB has only job infrastructure tables`,
        );
        continue;
      }

      await jobsService.ensureJobLinkedToApp(reference.jobId, appId);

      const source: Omit<AppDataSource, "linkedAt"> = {
        id: `${job.id}:auto-discovered`,
        type: "sqlite",
        jobId: job.id,
        alias: job.name,
        dbPath: reference.dbPath,
        tables: [],
      };

      const linked = await this.linkAppDataSource(appId, source);
      const created = linked.find((entry) => entry.jobId === job.id);
      if (created) {
        newSources.push(created);
        console.log(
          `[AppService] Auto-linked data source from code (${reference.matchedBy}): ${job.name} → ${app.title}`,
        );
      }
    }

    return newSources;
  }

  getAppsRootPath(): string {
    return this.appsDir;
  }

  async upsertApp(app: MiniApp, sourceDir?: string): Promise<MiniApp> {
    const appDir = path.join(this.appsDir, app.id);
    await fs.mkdir(appDir, { recursive: true });
    if (sourceDir) {
      await fs.cp(sourceDir, appDir, { recursive: true });
    }

    // Resolve icon from directory if not already set
    if (!app.icon) {
      const dirIcon = await this.resolveIconFromAppDir(appDir);
      if (dirIcon) {
        app.icon = dirIcon;
      }
    }

    this.apps.set(app.id, app);
    await this.saveApps();
    
    // Start watching the app directory
    await this.watchApp(app.id);
    
    return app;
  }

  async toggleFavorite(id: string): Promise<MiniApp | null> {
    const app = this.apps.get(id);
    if (!app) return null;

    app.favorite = !app.favorite;
    app.updatedAt = new Date().toISOString();

    this.apps.set(id, app);
    await this.saveApps();

    return app;
  }

  /**
   * Cleanup: stop all file watchers
   */
  cleanup(): void {
    this.disposed = true;
    console.log(`[AppService] Cleaning up ${this.watchers.size} watchers`);
    
    for (const [_appId, watcher] of this.watchers.entries()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Reload broadcasts fire up to 1.5s after the last edit. Leaving them armed
    // kept the process alive past shutdown and, under vitest, let a worker post
    // messages after the pool closed — surfacing as an unrelated IPC crash.
    for (const timer of this.reloadBroadcastTimers.values()) {
      clearTimeout(timer);
    }
    this.reloadBroadcastTimers.clear();
  }
}

/**
 * Parse a version ID like "2026-03-17T12-30-00-000Z_auto" back into an ISO timestamp.
 */
function versionIdToTimestamp(versionId: string): string {
  // Version ID format: "2026-03-17T15-23-56-289Z_reason"
  const firstUnderscore = versionId.indexOf("_");
  const raw = firstUnderscore >= 0 ? versionId.slice(0, firstUnderscore) : versionId;
  return raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
}

/**
 * Get or create AppService singleton
 */
export function getAppService(): AppService {
  if (!appServiceInstance) {
    appServiceInstance = new AppService();
  }
  return appServiceInstance;
}

/** Reset singleton between unit tests (avoids stale HOME paths). */
export function resetAppServiceSingletonForTests(): void {
  appServiceInstance?.cleanup();
  appServiceInstance = null;
}

/**
 * Initialize AppService
 */
export async function initializeAppService(): Promise<AppService> {
  const service = getAppService();
  await service.initialize();
  return service;
}
