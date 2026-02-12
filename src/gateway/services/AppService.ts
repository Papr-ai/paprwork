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
}

export interface AppFile {
  filename: string;
  content: string;
}

let appServiceInstance: AppService | null = null;

export class AppService {
  private appsDir: string;
  private appsIndexPath: string;
  private apps: Map<string, MiniApp>;
  private initialized: boolean;

  constructor() {
    const homeDir = os.homedir();
    this.appsDir = path.join(homeDir, ".paprwork", "apps");
    this.appsIndexPath = path.join(homeDir, ".paprwork", "data", "apps.json");
    this.apps = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

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

  async createApp(
    title: string,
    description: string,
    files: AppFile[],
  ): Promise<MiniApp> {
    const now = new Date().toISOString();
    const app: MiniApp = {
      id: uuidv4(),
      title,
      description,
      type: "app",
      createdAt: now,
      updatedAt: now,
      favorite: false,
    };

    // Create app directory
    const appPath = path.join(this.appsDir, app.id);
    await fs.mkdir(appPath, { recursive: true });

    // Write files
    for (const file of files) {
      const filePath = path.join(appPath, file.filename);
      await fs.writeFile(filePath, file.content);
    }

    this.apps.set(app.id, app);
    await this.saveApps();

    console.log(`[AppService] Created app: ${app.id} - ${title}`);
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
      await fs.writeFile(filePath, content);

      // Update app's updatedAt
      app.updatedAt = new Date().toISOString();
      await this.saveApps();

      return true;
    } catch (error) {
      console.error(`[AppService] Failed to write file: ${filename}`, error);
      return false;
    }
  }

  async getAppPath(appId: string): Promise<string | null> {
    const app = this.apps.get(appId);
    if (!app) return null;
    return path.join(this.appsDir, appId);
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
