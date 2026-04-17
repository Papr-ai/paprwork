/**
 * AppService - Mini-app management
 * Reference: Paprwork v1 appManager.js
 */

import { promises as fs } from "fs";
import chokidar, { type FSWatcher } from "chokidar";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

// ESM compatibility: get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  createdByAgentId?: string;
  createdByAgentName?: string;
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

export interface AppDataSource {
  id: string;
  type: "sqlite";
  jobId: string;
  alias: string;
  dbPath: string;
  tables: string[];
  linkedAt: string;
}

export interface ValidationIssue {
  file: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
  rule?: string;
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
  private paprRootDir: string;
  private appsDir: string;
  private appsIndexPath: string;
  private legacyAppsDir: string;
  private legacyAppsIndexPath: string;
  private apps: Map<string, MiniApp>;
  private initialized: boolean;
  private watchers: Map<string, FSWatcher>;
  private debounceTimers: Map<string, NodeJS.Timeout>;
  private pendingDefaultJobs: Array<{ sourceDir: string; targetDir: string; appId: string }>;

  constructor() {
    const homeDir = os.homedir();
    this.paprRootDir = path.join(homeDir, "Papr");
    this.appsDir = path.join(this.paprRootDir, "apps");
    this.appsIndexPath = path.join(this.paprRootDir, "data", "apps.json");
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
    this.pendingDefaultJobs = [];
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
        const app: MiniApp = {
          id: appId,
          title: metadata.title || appDirName,
          description: metadata.description || "Default app",
          type: "app",
          createdAt: metadata.createdAt || now,
          updatedAt: now,
          favorite: metadata.favorite || false,
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
      jobDef as Parameters<typeof jobsService.installDefaultJob>[0],
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
      const dataSources = JSON.parse(dsContent) as Array<{
        jobId?: string;
        dbPath?: string;
        [key: string]: unknown;
      }>;

      let updated = false;
      for (const ds of dataSources) {
        if (ds.jobId === jobDef.id && (!ds.dbPath || ds.dbPath === "")) {
          ds.dbPath = dbPath;
          updated = true;
        }
      }

      if (updated) {
        await fs.writeFile(dataSourcesPath, JSON.stringify(dataSources, null, 2));
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

      // Restore user's data-sources.json (may have custom dbPath)
      if (savedDataSources) {
        await fs.writeFile(dsPath, savedDataSources);
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

    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.appsDir, { recursive: true });
    await fs.mkdir(path.dirname(this.appsIndexPath), { recursive: true });
    await this.loadApps(); // Load existing apps FIRST
    await this.rebuildIndexIfCorrupted(); // Safety net: check for missing apps
    await this.pruneStaleAppEntries(); // Index entries whose folders were removed (e.g. bash rm)
    await this.installDefaultApps(); // Then install defaults (won't overwrite existing)
    await this.startWatchingApps();
    this.initialized = true;
    console.log(`[AppService] Initialized with ${this.apps.size} apps`);
  }


  /**
   * Safety net: detect if apps.json is missing apps that exist on disk.
   * This handles corruption from updates, crashes, or the previous bug where
   * installDefaultApps() could overwrite apps.json before loadApps() ran.
   * Scans ~/Papr/apps/ for app directories not in the index and re-adds them.
   */
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

      console.warn(
        `[AppService] INDEX CORRUPTION DETECTED: ${missingAppIds.length} apps on disk but missing from apps.json. Rebuilding...`
      );

      // Back up the corrupted index before fixing
      try {
        const backupPath = this.appsIndexPath + `.backup-${Date.now()}`;
        await fs.copyFile(this.appsIndexPath, backupPath);
        console.log(`[AppService] Backed up corrupted index to ${backupPath}`);
      } catch {
        // No existing file to back up — that's fine
      }

      for (const appId of missingAppIds) {
        const appDir = path.join(this.appsDir, appId);

        // Try to recover metadata from files
        let title = appId;
        let description = "Recovered app (index was corrupted)";
        let icon: string | undefined;
        let createdAt = new Date().toISOString();

        // Try reading index.html for <title> tag
        try {
          const indexHtml = await fs.readFile(path.join(appDir, "index.html"), "utf-8");
          const titleMatch = indexHtml.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            title = titleMatch[1].trim();
          }
          // Try extracting favicon
          const favicon = this.extractFaviconFromHTML(indexHtml);
          if (favicon) {
            icon = favicon;
          }
        } catch {
          // No index.html, try other files for hints
        }

        // Try to get actual creation date from filesystem
        try {
          const stat = await fs.stat(appDir);
          createdAt = stat.birthtime.toISOString();
        } catch {
          // Use current time
        }

        // Try resolving icon from logo files
        if (!icon) {
          const resolvedIcon = await this.resolveIconFromAppDir(appDir);
          if (resolvedIcon) {
            icon = resolvedIcon;
          }
        }

        const recoveredApp: MiniApp = {
          id: appId,
          title,
          description,
          type: "app",
          createdAt,
          updatedAt: new Date().toISOString(),
          ...(icon ? { icon } : {}),
        };

        this.apps.set(appId, recoveredApp);
        console.log(`[AppService] Recovered app from disk: ${appId} - ${title}`);
      }

      await this.saveApps();
      console.log(
        `[AppService] Index rebuilt: recovered ${missingAppIds.length} apps. Total: ${this.apps.size}`
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
  }

  private async saveApps(): Promise<void> {
    const appsArray = Array.from(this.apps.values());
    const data = JSON.stringify(appsArray, null, 2);
    const tmpPath = this.appsIndexPath + `.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, data, "utf8");
    await fs.rename(tmpPath, this.appsIndexPath);
  }

  /**
   * Extract SVG favicon from an HTML string's <link rel="icon" href="data:image/svg+xml,..."> tag.
   * Mirrors the logic from Paprwork v1 appManager.js extractFaviconFromHTML.
   */
  private extractFaviconFromHTML(html: string): string | null {
    const linkMatch = html.match(/<link[^>]+rel=["']icon["'][^>]*>/i);
    if (!linkMatch) return null;

    const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return null;

    const href = hrefMatch[1];
    if (!href.startsWith("data:image/svg+xml,")) return null;

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
  ): Promise<MiniApp> {
    const now = new Date().toISOString();

    // Resolve icon: explicit icon wins, then auto-extract from index.html favicon
    let resolvedIcon = icon ?? null;
    if (!resolvedIcon) {
      const indexFile = files.find((f) => f.filename === "index.html");
      if (indexFile) {
        resolvedIcon = this.extractFaviconFromHTML(indexFile.content);
      }
    }

    const app: MiniApp = {
      id: uuidv4(),
      title,
      description,
      type: "app",
      createdAt: now,
      updatedAt: now,
      favorite: false,
      ...(resolvedIcon ? { icon: resolvedIcon } : {}),
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
      const dirIcon = await this.resolveIconFromAppDir(appPath);
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
        app_name: title.length > 80 ? `${title.slice(0, 79)}…` : title,
        has_icon: !!app.icon,
        file_count: files.length,
      });
    }).catch(() => {});

    console.log(
      `[AppService] Created app: ${app.id} - ${title} (verified files on disk)`,
    );
    return app;
  }

  async getApp(id: string): Promise<MiniApp | null> {
    return this.apps.get(id) || null;
  }

  async updateApp(
    id: string,
    updates: Partial<Omit<MiniApp, "id" | "type" | "createdAt">>,
  ): Promise<MiniApp | null> {
    const app = this.apps.get(id);
    if (!app) return null;

    const updatedApp: MiniApp = {
      ...app,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.apps.set(id, updatedApp);
    await this.saveApps();

    import("./gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_app_edited", {
        app_id: id,
        app_name: updatedApp.title.length > 80 ? `${updatedApp.title.slice(0, 79)}…` : updatedApp.title,
      });
    }).catch(() => {});

    console.log(`[AppService] Updated app: ${id}`);
    return updatedApp;
  }

  async deleteApp(id: string): Promise<boolean> {
    const app = this.apps.get(id);
    if (!app) return false;

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
    return true;
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
        broadcast({ type: "app:list-updated" });
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  async listApps(): Promise<MiniApp[]> {
    await this.initialize();
    await this.pruneStaleAppEntries();
    return Array.from(this.apps.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async readAppFile(appId: string, filename: string): Promise<string | null> {
    const app = this.apps.get(appId);
    if (!app) return null;

    const filePath = path.join(this.appsDir, appId, filename);
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      console.error(`[AppService] Failed to read file: ${filename}`, error);
      return null;
    }
  }

  async writeAppFile(
    appId: string,
    filename: string,
    content: string,
  ): Promise<boolean> {
    const app = this.apps.get(appId);
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

      // Broadcast file change to all connected clients (triggers iframe reload)
      this.broadcastFileChange(appId, filename);

      return true;
    } catch (error) {
      console.error(`[AppService] Failed to write file: ${filename}`, error);
      return false;
    }
  }

  /**
   * Start watching all app directories for file changes
   */
  private async startWatchingApps(): Promise<void> {
    for (const app of this.apps.values()) {
      await this.watchApp(app.id);
    }
    console.log(`[AppService] Started watching ${this.watchers.size} app directories`);
  }

  /**
   * Watch a specific app directory for file changes
   */
  private async watchApp(appId: string): Promise<void> {
    const appPath = path.join(this.appsDir, appId);

    // Check if directory exists before watching
    try {
      await fs.access(appPath);
    } catch {
      return; // Directory doesn't exist yet
    }

    // Don't create duplicate watchers
    if (this.watchers.has(appId)) {
      return;
    }

    try {
      const watcher = chokidar.watch(appPath, {
        persistent: true,
        ignoreInitial: true,
        ignored: [
          "**/.versions/**",
          "**/data-sources.json",
          "**/.*", // Hidden files
        ],
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
        console.error(`[AppService] Watcher error for app ${appId}:`, error);
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
    this.broadcastFileChange(appId, filename);
    
    // Run validation asynchronously (don't block file change broadcast)
    this.runValidation(appId).catch((error) => {
      console.error(`[AppService] Validation error for app ${appId}:`, error);
    });
  }

  /**
   * Validate an app's files (linting + LOC checks) - Public API
   */
  async validateApp(appId: string): Promise<ValidationResult> {
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

    // Check each file
    for (const file of filesToCheck) {
      const relativePath = path.relative(appPath, file);
      const ext = path.extname(file).toLowerCase();

      // Skip non-source files
      if (!['.html', '.css', '.js', '.ts', '.tsx', '.jsx'].includes(ext)) {
        continue;
      }

      try {
        const content = await fs.readFile(file, 'utf-8');
        
        // LOC check (100 lines max for mini-apps)
        const locIssues = this.checkLineLimit(content, relativePath, 100);
        issues.push(...locIssues);

        // Basic syntax checks
        if (ext === '.html') {
          const htmlIssues = this.checkHtmlSyntax(content, relativePath);
          issues.push(...htmlIssues);
        } else if (ext === '.css') {
          const cssIssues = this.checkCssSyntax(content, relativePath);
          issues.push(...cssIssues);
        } else if (['.js', '.ts', '.tsx', '.jsx'].includes(ext)) {
          const jsIssues = this.checkJavaScriptSyntax(content, relativePath);
          issues.push(...jsIssues);
        }
      } catch (error) {
        console.error(`[AppService] Failed to validate ${relativePath}:`, error);
      }
    }

    // Broadcast validation result
    const result: ValidationResult = {
      appId,
      timestamp: new Date().toISOString(),
      valid: issues.length === 0,
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
        
        // Skip hidden files, versions, and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
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
        severity: 'error',
        message: `File has ${significantLines} lines (${excess} over the ${maxLines} line limit). Break into smaller components.`,
        rule: 'max-lines',
      }];
    }

    return [];
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
  private checkJavaScriptSyntax(content: string, filename: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lines = content.split('\n');

    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip comments and strings (basic check)
      if (line.startsWith('//') || line.startsWith('/*')) continue;
      
      // Count delimiters
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      parenCount += (line.match(/\(/g) || []).length;
      parenCount -= (line.match(/\)/g) || []).length;
      bracketCount += (line.match(/\[/g) || []).length;
      bracketCount -= (line.match(/]/g) || []).length;
      
      // Check for console.log (should be removed in production)
      if (line.includes('console.log')) {
        issues.push({
          file: filename,
          line: i + 1,
          severity: 'warning',
          message: 'Remove console.log statements before production',
          rule: 'no-console',
        });
      }
    }

    if (braceCount !== 0) {
      issues.push({
        file: filename,
        severity: 'error',
        message: `Mismatched braces (${braceCount > 0 ? 'missing closing' : 'extra closing'})`,
        rule: 'syntax',
      });
    }

    if (parenCount !== 0) {
      issues.push({
        file: filename,
        severity: 'error',
        message: `Mismatched parentheses (${parenCount > 0 ? 'missing closing' : 'extra closing'})`,
        rule: 'syntax',
      });
    }

    if (bracketCount !== 0) {
      issues.push({
        file: filename,
        severity: 'error',
        message: `Mismatched brackets (${bracketCount > 0 ? 'missing closing' : 'extra closing'})`,
        rule: 'syntax',
      });
    }

    return issues;
  }

  /**
   * Broadcast validation result to all connected clients
   */
  private broadcastValidation(result: ValidationResult): void {
    if (result.issues.length > 0) {
      console.log(
        `[AppService] Validation found ${result.issues.length} issue(s) in app ${result.appId}`,
      );
      
      // Log errors to console for agent visibility
      for (const issue of result.issues) {
        const prefix = issue.severity === 'error' ? '❌' : '⚠️';
        const location = issue.line ? `:${issue.line}` : '';
        console.log(`${prefix} ${issue.file}${location} - ${issue.message}`);
      }
    }

    import("../websocket/index.js")
      .then(({ broadcast }) => {
        broadcast({
          type: "app:validation-result",
          data: result,
        });
      })
      .catch((error) => {
        console.warn("[AppService] Failed to broadcast validation:", error);
      });
  }

  /**
   * Broadcast app file change to all connected clients
   */
  private broadcastFileChange(appId: string, filename: string): void {
    import("../websocket/index.js")
      .then(({ broadcast }) => {
        broadcast({
          type: "app:file-changed",
          data: { appId, filename, timestamp: Date.now() },
        });
        console.log(
          `[AppService] Broadcasted file change: ${appId}/${filename}`,
        );
      })
      .catch((error) => {
        console.warn("[AppService] Failed to broadcast file change:", error);
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

    this.broadcastFileChange(appId, filename);
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

  async listAppDataSources(appId: string): Promise<AppDataSource[]> {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }
    const dataSourcesPath = this.getDataSourcesPath(appId);
    try {
      const raw = await fs.readFile(dataSourcesPath, "utf8");
      const parsed = JSON.parse(raw) as AppDataSource[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async linkAppDataSource(
    appId: string,
    source: Omit<AppDataSource, "linkedAt">,
  ): Promise<AppDataSource[]> {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    const existing = await this.listAppDataSources(appId);
    const linked: AppDataSource = {
      ...source,
      linkedAt: new Date().toISOString(),
    };
    const next = [
      linked,
      ...existing.filter((entry) => entry.id !== linked.id),
    ];
    await fs.writeFile(
      this.getDataSourcesPath(appId),
      JSON.stringify(next, null, 2),
      "utf8",
    );

    app.updatedAt = new Date().toISOString();
    this.apps.set(app.id, app);
    await this.saveApps();
    return next;
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
    const existingSources = await this.listAppDataSources(appId);
    const existingJobIds = new Set(existingSources.map(ds => ds.jobId));
    
    // Build map of database paths to jobs
    const dbPathToJob = new Map<string, typeof allJobs[0]>();
    for (const job of allJobs) {
      const dbPath = await jobsService.getJobDatabasePath(job.id);
      if (dbPath) {
        dbPathToJob.set(dbPath, job);
      }
    }
    
    // Scan app code for database references
    const appDir = path.join(this.appsDir, appId);
    const referencedDbPaths = await this.scanAppCodeForDatabasePaths(appDir);
    
    // Link jobs whose databases are referenced in the app
    const newSources: AppDataSource[] = [];
    for (const dbPath of referencedDbPaths) {
      const job = dbPathToJob.get(dbPath);
      if (!job || existingJobIds.has(job.id)) continue;

      const source: Omit<AppDataSource, "linkedAt"> = {
        id: `${job.id}:auto-discovered`,
        type: "sqlite",
        jobId: job.id,
        alias: job.name,
        dbPath,
        tables: [], // Tables will be discovered on first query
      };

      await this.linkAppDataSource(appId, source);
      newSources.push({ ...source, linkedAt: new Date().toISOString() });
      console.log(`[AppService] Auto-linked data source: ${job.name} → ${app.title}`);
    }

    return newSources;
  }

  /**
   * Scan mini-app code files for database path references.
   * Looks for:
   * - fetch('/api/db/query', ...) calls with specific database paths
   * - Direct database file references in code
   * 
   * @param appDir - App directory to scan
   * @returns Set of database paths referenced in the app code
   */
  private async scanAppCodeForDatabasePaths(appDir: string): Promise<Set<string>> {
    const dbPaths = new Set<string>();
    
    try {
      const files = await fs.readdir(appDir);
      const codeFiles = files.filter(f => 
        f.endsWith('.js') || 
        f.endsWith('.ts') || 
        f.endsWith('.html')
      );

      for (const file of codeFiles) {
        const filePath = path.join(appDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        
        // Look for database paths in the code
        // Pattern 1: Explicit db paths: /Users/.../Papr/jobs/{jobId}/data/*.db
        const dbPathPattern = /\/Papr\/jobs\/([a-f0-9-]+)\/data\/[^'"]+\.db/gi;
        let match;
        while ((match = dbPathPattern.exec(content)) !== null) {
          dbPaths.add(match[0]);
        }
        
        // Pattern 2: Job ID references that imply database usage
        // If app code references a job ID, it's likely querying that job's database
        const jobIdPattern = /['"]([a-f0-9-]{36})['"]/g;
        const homeDir = os.homedir();
        while ((match = jobIdPattern.exec(content)) !== null) {
          const jobId = match[1];
          // Try both standard paths
          const possiblePaths = [
            path.join(homeDir, 'Papr', 'jobs', jobId, 'data', 'data.db'),
            path.join(homeDir, 'Papr', 'jobs', jobId, 'data', 'data.db'),
          ];
          for (const p of possiblePaths) {
            try {
              await fs.access(p);
              dbPaths.add(p);
              break;
            } catch {
              // Path doesn't exist, try next
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[AppService] Failed to scan app code for db paths:`, err);
    }

    return dbPaths;
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
    console.log(`[AppService] Cleaning up ${this.watchers.size} watchers`);
    
    for (const [_appId, watcher] of this.watchers.entries()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
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

/**
 * Initialize AppService
 */
export async function initializeAppService(): Promise<AppService> {
  const service = getAppService();
  await service.initialize();
  return service;
}
