/**
 * Watch app-linked job SQLite files and schedule debounced Turso push on change.
 *
 * Watches each linked job's `data/` directory so writes are detected whether they
 * land on `data.db`, `data.db-wal`, or `data.db-shm` (WAL mode, long-lived jobs,
 * mini-app /api/db/write, bash sqlite, etc.). Debounced push + fingerprints still
 * decide whether Turso actually needs an upload at flush time.
 */

import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { discoverTursoLinkedSources, linkedSourceSyncKey } from "./tursoLinkedSources.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import {
  ensureLocalDbChangeLogReady,
  isSqliteBusyError,
  isTursoLocalDatabaseCorruptError,
  localDbHasSyncableUserTables,
} from "./tursoSyncBridgeCore.js";
import { publishDbChanged } from "../utils/publishJobRunEvents.js";
import {
  clearStaleDirtyFlagIfClean,
  hasUnpushedLocalDbChanges,
  isJobDbQuarantined,
  loadTursoSyncState,
  recordTursoPushQuarantine,
} from "./tursoSyncState.js";
import { getSyncCoordinator } from "./cloudSync/SyncCoordinator.js";

let watcher: FSWatcher | null = null;

interface WatchedDbDir {
  syncKey: string;
  dbPath: string;
  jobId?: string;
  dbId?: string;
}

const dbDirToSource = new Map<string, WatchedDbDir>();

function normalizePath(filePath: string): string {
  return path.normalize(filePath);
}

/** Linked job SQLite artifacts under `.../data/`. */
export function isLinkedJobSqliteFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === "data.db" || base === "data.db-wal" || base === "data.db-shm";
}

export function resolveJobIdForDbFileChange(
  changedPath: string,
  dirToSource: ReadonlyMap<string, WatchedDbDir>,
): WatchedDbDir | undefined {
  const normalized = normalizePath(changedPath);
  if (!isLinkedJobSqliteFile(normalized)) {
    return undefined;
  }
  return dirToSource.get(path.dirname(normalized));
}

async function rebuildWatchDirs(appsRootDir: string): Promise<string[]> {
  dbDirToSource.clear();
  const sources = await discoverTursoLinkedSources(appsRootDir);
  const dataDirs: string[] = [];

  for (const source of sources) {
    const dataDir = path.dirname(normalizePath(source.dbPath));
    if (!dbDirToSource.has(dataDir)) {
      dbDirToSource.set(dataDir, {
        syncKey: linkedSourceSyncKey(source),
        dbPath: source.dbPath,
        ...(source.jobId ? { jobId: source.jobId } : {}),
        ...(source.dbId ? { dbId: source.dbId } : {}),
      });
      dataDirs.push(dataDir);
    }
  }

  return dataDirs;
}

function handleDbChange(changedPath: string): void {
  const watched = resolveJobIdForDbFileChange(changedPath, dbDirToSource);
  if (!watched) {
    return;
  }

  try {
    ensureLocalDbChangeLogReady(watched.dbPath);
  } catch (error) {
    const message = (error as Error).message;
    if (isSqliteBusyError(error)) {
      console.warn(
        `[TursoLinkedDbWatcher] DB busy, deferring changelog setup for ${watched.syncKey}`,
      );
    } else if (isTursoLocalDatabaseCorruptError(message)) {
      recordTursoPushQuarantine(watched.syncKey, watched.dbPath, message);
    } else {
      console.warn(
        `[TursoLinkedDbWatcher] Changelog setup failed for ${watched.syncKey}:`,
        message,
      );
    }
    return;
  }

  const syncState = loadTursoSyncState();
  if (isJobDbQuarantined(watched.syncKey, syncState)) {
    return;
  }

  if (!localDbHasSyncableUserTables(watched.dbPath)) {
    return;
  }

  if (!hasUnpushedLocalDbChanges(watched.syncKey, watched.dbPath, syncState)) {
    clearStaleDirtyFlagIfClean(watched.syncKey, watched.dbPath);
    return;
  }

  const coordinator = getSyncCoordinator();
  if (coordinator) {
    coordinator.markDbDirty(watched.syncKey, watched.dbPath, "watcher");
  } else {
    void import("./tursoPushScheduler.js").then(({ scheduleTursoPushForJob }) => {
      scheduleTursoPushForJob(watched.syncKey, "normal", "watcher");
    });
  }
  publishDbChanged({
    ...(watched.jobId ? { jobId: watched.jobId } : {}),
    ...(watched.dbId ? { dbId: watched.dbId } : {}),
  });
}

export async function startTursoLinkedDbWatcher(
  appsRootDir?: string,
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const root = appsRootDir ?? bridge.getAppsRootDir();
  await stopTursoLinkedDbWatcher();

  const watchDirs = await rebuildWatchDirs(root);
  if (watchDirs.length === 0) {
    return;
  }

  watcher = chokidar.watch(watchDirs, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 250 },
  });

  watcher
    .on("add", handleDbChange)
    .on("change", handleDbChange)
    .on("unlink", handleDbChange);

  await new Promise<void>((resolve, reject) => {
    watcher!.once("ready", () => resolve());
    watcher!.once("error", (err) => reject(err));
  });

  console.log(
    `[TursoLinkedDbWatcher] Watching ${dbDirToSource.size} linked job data dir(s) (data.db + WAL/SHM)`,
  );
}

export async function refreshTursoLinkedDbWatcher(
  appsRootDir?: string,
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }
  bridge.invalidateLinkedSourcesCache();
  await startTursoLinkedDbWatcher(appsRootDir);
}

export async function stopTursoLinkedDbWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  dbDirToSource.clear();
}

export function defaultAppsRootDir(): string {
  return getPaprAppsRoot();
}

/** @internal test helper */
export function resolveWatchedDbPathForTests(changedPath: string): string | null {
  const watched = resolveJobIdForDbFileChange(changedPath, dbDirToSource);
  if (!watched) {
    return null;
  }
  return normalizePath(changedPath);
}

/** @internal test helper */
export function registerWatchedDbPathForTests(dbPath: string, jobId: string): void {
  const dataDir = path.dirname(normalizePath(dbPath));
  dbDirToSource.set(dataDir, {
    syncKey: jobId,
    dbPath: normalizePath(dbPath),
    jobId,
  });
}
