/**
 * Persistent sync state — tracks which subdirs have been synced
 * so restarts only re-queue items that changed.
 *
 * State file: ~/Papr/.cloud-sync-state.json
 */

import * as fs from "fs";
import * as path from "path";

export const STATE_FILENAME = ".cloud-sync-state.json";

export interface PersistedSyncState {
  syncedItems: Record<string, { lastSyncAt: string; contentHash: string }>;
  lastFullSyncAt: string | null;
}

export interface QueueItem {
  relativePath: string;
  failures: number;
}

const IGNORED_DIRS = new Set([
  "venv", ".venv", "node_modules", "__pycache__",
  "dist", ".versions", "logs", "chrome-profile",
]);

export class SyncStateManager {
  private state: PersistedSyncState = { syncedItems: {}, lastFullSyncAt: null };
  private readonly paprDir: string;

  constructor(paprDir: string) {
    this.paprDir = paprDir;
  }

  get statePath(): string {
    return path.join(this.paprDir, STATE_FILENAME);
  }

  get data(): PersistedSyncState {
    return this.state;
  }

  load(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        this.state = JSON.parse(raw) as PersistedSyncState;
        const itemCount = Object.keys(this.state.syncedItems).length;
        console.log(`[CloudSync] Loaded sync state: ${itemCount} previously synced items`);
      }
    } catch {
      console.warn("[CloudSync] Could not load sync state — will re-sync all");
      this.state = { syncedItems: {}, lastFullSyncAt: null };
    }
  }

  save(): void {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.warn("[CloudSync] Could not save sync state:", (err as Error).message);
    }
  }

  markSynced(relativePath: string): void {
    this.state.syncedItems[relativePath] = {
      lastSyncAt: new Date().toISOString(),
      contentHash: this.computeContentHash(relativePath),
    };
  }

  markFullSyncComplete(): void {
    this.state.lastFullSyncAt = new Date().toISOString();
  }

  resetForNewRepo(): void {
    this.state = { syncedItems: {}, lastFullSyncAt: null };
    this.save();
    console.log("[CloudSync] Cleared sync state for new Papr org repo");
  }

  /** Force re-queue of all apps/jobs/workspace after splitting a failed batch upload. */
  invalidateAllSyncedItems(): void {
    this.state.syncedItems = {};
    this.state.lastFullSyncAt = null;
  }

  removeSyncedItem(relativePath: string): void {
    delete this.state.syncedItems[relativePath];
  }

  hasItemChanged(relativePath: string): boolean {
    const prev = this.state.syncedItems[relativePath];
    if (!prev) return true;
    const currentHash = this.computeContentHash(relativePath);
    return currentHash !== prev.contentHash;
  }

  /**
   * Return all previously synced items whose paths no longer exist on disk.
   */
  getDeletedItems(): string[] {
    const deleted: string[] = [];
    for (const relativePath of Object.keys(this.state.syncedItems)) {
      const fullPath = path.join(this.paprDir, relativePath);
      if (!fs.existsSync(fullPath)) {
        deleted.push(relativePath);
      }
    }
    return deleted;
  }

  /**
   * Lightweight content hash using mtime + size.
   * For directories, scans top-level entries (skipping ignored dirs).
   */
  private computeContentHash(relativePath: string): string {
    const fullPath = path.join(this.paprDir, relativePath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return this.computeDirHash(fullPath);
      }
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  private computeDirHash(dirPath: string): string {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      let latest = 0;
      let totalSize = 0;
      let fileCount = 0;

      for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const entryPath = path.join(dirPath, entry.name);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.mtimeMs > latest) latest = stat.mtimeMs;
          totalSize += stat.size;
          fileCount++;
        } catch {
          /* skip inaccessible files */
        }
      }

      return `${latest}:${totalSize}:${fileCount}`;
    } catch {
      return "error";
    }
  }
}
