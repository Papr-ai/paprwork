/**
 * AppService - Mini-app management
 * Reference: Paprwork v1 appManager.js
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

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

let appServiceInstance: AppService | null = null;

export class AppService {
  private paprRootDir: string;
  private appsDir: string;
  private appsIndexPath: string;
  private legacyAppsDir: string;
  private legacyAppsIndexPath: string;
  private apps: Map<string, MiniApp>;
  private initialized: boolean;

  constructor() {
    const homeDir = os.homedir();
    this.paprRootDir = path.join(homeDir, "PAPR");
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

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.appsDir, { recursive: true });
    await fs.mkdir(path.dirname(this.appsIndexPath), { recursive: true });
    await this.loadApps();
    this.initialized = true;
    console.log(`[AppService] Initialized with ${this.apps.size} apps`);
  }

  private async loadApps(): Promise<void> {
    try {
      const data = await fs.readFile(this.appsIndexPath, "utf-8");
      const appsArray: MiniApp[] = JSON.parse(data);
      this.apps = new Map(appsArray.map((app) => [app.id, app]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[AppService] Failed to load apps:", error);
      }
      this.apps = new Map();
    }
  }

  private async saveApps(): Promise<void> {
    const appsArray = Array.from(this.apps.values());
    await fs.writeFile(this.appsIndexPath, JSON.stringify(appsArray, null, 2));
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

    this.apps.set(app.id, app);
    await this.saveApps();

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

    console.log(`[AppService] Updated app: ${id}`);
    return updatedApp;
  }

  async deleteApp(id: string): Promise<boolean> {
    const app = this.apps.get(id);
    if (!app) return false;

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

    console.log(`[AppService] Deleted app: ${id}`);
    return true;
  }

  async listApps(): Promise<MiniApp[]> {
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

  getAppsRootPath(): string {
    return this.appsDir;
  }

  async upsertApp(app: MiniApp, sourceDir?: string): Promise<MiniApp> {
    const appDir = path.join(this.appsDir, app.id);
    await fs.mkdir(appDir, { recursive: true });
    if (sourceDir) {
      await fs.cp(sourceDir, appDir, { recursive: true });
    }
    this.apps.set(app.id, app);
    await this.saveApps();
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
