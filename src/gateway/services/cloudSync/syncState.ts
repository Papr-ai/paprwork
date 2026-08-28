/**
 * Persistent sync state — tracks which subdirs have been synced
 * so restarts only re-queue items that changed.
 *
 * State file: ~/Papr/.cloud-sync-state.json
 */

import * as fs from "fs";
import * as path from "path";
import { isLocalOnlyCloudSyncArtifact, isTooLargeForGitSync } from "./gitSyncLimits.js";

export const STATE_FILENAME = ".cloud-sync-state.json";

export interface SyncedItemRecord {
  lastSyncAt: string;
  contentHash: string;
}

export interface DeadLetterItem {
  lastFailedAt: string;
  failures: number;
  lastError: string;
}

export interface PersistedSyncState {
  syncedItems: Record<string, SyncedItemRecord>;
  lastFullSyncAt: string | null;
  /** Items that failed MAX_RETRY times — not re-queued until user retries. */
  deadLetter?: Record<string, DeadLetterItem>;
}

export interface QueueItem {
  relativePath: string;
  failures: number;
}

const IGNORED_DIRS = new Set([
  "venv", ".venv", "node_modules", "__pycache__",
  "dist", ".versions", "logs", "chrome-profile",
]);

/** Cloud-prep outputs — excluded from hash so prepareAppForCloudGitSync does not re-queue. */
export const HASH_IGNORED_RELATIVE_SUFFIXES = [
  "backend/bundle.json",
  "requirements.json",
  "data/cloud-repo-head.txt",
  ".papr-cloud-revision",
  "linked-databases.json",
  "__papr__/app-meta.json",
  "__papr__/platform-catalog.json",
] as const;

/** Generated cloud-prep files — must not re-trigger app rebuild, iframe reload, or auto flush. */
export function isCloudPrepGitSyncArtifact(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return HASH_IGNORED_RELATIVE_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`),
  );
}

/**
 * SQLite sidecars — synced via Turso, gitignored in CloudSyncService.
 * Exclude from hash so job DB activity does not re-queue git sync on every startup.
 */
const SQLITE_HASH_IGNORED_SUFFIXES = [".db-shm", ".db-wal", ".db"] as const;

export function shouldExcludePathFromContentHash(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.endsWith("/job.runtime.json") ||
    normalized === "data/job-runs.jsonl"
  ) {
    return true;
  }
  if (isCloudPrepGitSyncArtifact(normalized)) {
    return true;
  }

  const baseName = path.basename(normalized);
  if (isLocalOnlyCloudSyncArtifact(baseName)) {
    return true;
  }
  return SQLITE_HASH_IGNORED_SUFFIXES.some((suffix) => baseName.endsWith(suffix));
}

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
        if (!this.state.deadLetter) {
          this.state.deadLetter = {};
        }
        const itemCount = Object.keys(this.state.syncedItems).length;
        const deadCount = Object.keys(this.state.deadLetter).length;
        console.log(
          `[CloudSync] Loaded sync state: ${itemCount} synced, ${deadCount} dead-letter`,
        );
      }
    } catch {
      console.warn("[CloudSync] Could not load sync state — will re-sync all");
      this.state = { syncedItems: {}, lastFullSyncAt: null, deadLetter: {} };
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
    this.clearDeadLetter(relativePath);
  }

  markFullSyncComplete(): void {
    this.state.lastFullSyncAt = new Date().toISOString();
  }

  resetForNewRepo(): void {
    this.state = { syncedItems: {}, lastFullSyncAt: null, deadLetter: {} };
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
    this.clearDeadLetter(relativePath);
  }

  isDeadLetter(relativePath: string): boolean {
    return Boolean(this.state.deadLetter?.[relativePath]);
  }

  getDeadLetter(relativePath: string): DeadLetterItem | undefined {
    return this.state.deadLetter?.[relativePath];
  }

  recordDeadLetter(relativePath: string, error: string, failures: number): void {
    if (!this.state.deadLetter) {
      this.state.deadLetter = {};
    }
    this.state.deadLetter[relativePath] = {
      lastFailedAt: new Date().toISOString(),
      failures,
      lastError: error.slice(0, 500),
    };
    this.save();
  }

  clearDeadLetter(relativePath: string): void {
    if (!this.state.deadLetter?.[relativePath]) {
      return;
    }
    delete this.state.deadLetter[relativePath];
  }

  /** User-initiated retry — clears dead-letter so the item can be queued again. */
  retryDeadLetter(relativePath: string): boolean {
    if (!this.isDeadLetter(relativePath)) {
      return false;
    }
    this.clearDeadLetter(relativePath);
    this.save();
    return true;
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
   * For directories, recurses while skipping ignored dirs and cloud-prep artifacts.
   */
  computeContentHash(relativePath: string): string {
    const fullPath = path.join(this.paprDir, relativePath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return this.computeDirHash(fullPath, relativePath);
      }
      if (shouldExcludePathFromContentHash(relativePath)) {
        return "ignored-artifact";
      }
      if (isTooLargeForGitSync(stat.size)) {
        return "ignored-large-file";
      }
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  private computeDirHash(dirPath: string, relativePrefix: string): string {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      let latest = 0;
      let totalSize = 0;
      let fileCount = 0;

      for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;

        const entryRelative = path.join(relativePrefix, entry.name).replace(/\\/g, "/");
        if (shouldExcludePathFromContentHash(entryRelative)) continue;

        const entryPath = path.join(dirPath, entry.name);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            const nested = this.computeDirHash(entryPath, entryRelative);
            if (nested !== "empty") {
              const parts = nested.split(":");
              const nestedLatest = Number(parts[0] ?? 0);
              const nestedSize = Number(parts[1] ?? 0);
              const nestedCount = Number(parts[2] ?? 0);
              if (nestedLatest > latest) latest = nestedLatest;
              totalSize += nestedSize;
              fileCount += nestedCount;
            }
            continue;
          }
          if (isTooLargeForGitSync(stat.size)) continue;
          if (stat.mtimeMs > latest) latest = stat.mtimeMs;
          totalSize += stat.size;
          fileCount++;
        } catch {
          /* skip inaccessible files */
        }
      }

      if (fileCount === 0) {
        return "empty";
      }
      return `${latest}:${totalSize}:${fileCount}`;
    } catch {
      return "error";
    }
  }
}
