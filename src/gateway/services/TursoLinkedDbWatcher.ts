/**
 * Watch app-linked job SQLite files and schedule debounced Turso push on change.
 *
 * Watches each linked job's `data/` directory so writes are detected whether they
 * land on `data.db`, `data.db-wal`, or `data.db-shm` (WAL mode, long-lived jobs,
 * mini-app /api/db/write, bash sqlite, etc.). Debounced ship via workspace log
 * decides whether remote Turso needs an update at flush time.
 */

import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import { TreeWatcher } from "./TreeWatcher.js";
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
  isTursoStateDbPathInWorkspace,
  loadTursoSyncState,
  recordTursoPushQuarantine,
} from "./tursoSyncState.js";
import { getSyncCoordinator } from "./cloudSync/SyncCoordinator.js";

let watcher: TreeWatcher | null = null;

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

/**
 * Coalesce bursts of data.db / -wal / -shm writes into one evaluation.
 *
 * Each evaluation checks the local `_papr_sync_log` for unpushed row ops,
 * so a busy job writing in a loop could otherwise pin the gateway event loop
 * and starve /health and the WebSocket heartbeat.
 */
const CHANGE_DEBOUNCE_MS = 750;

const pendingChangeTimers = new Map<string, NodeJS.Timeout>();

function handleDbChange(changedPath: string): void {
  const watched = resolveJobIdForDbFileChange(changedPath, dbDirToSource);
  if (!watched) {
    return;
  }

  const pending = pendingChangeTimers.get(watched.syncKey);
  if (pending) {
    clearTimeout(pending);
  }

  const timer = setTimeout(() => {
    pendingChangeTimers.delete(watched.syncKey);
    evaluateDbChange(watched);
  }, CHANGE_DEBOUNCE_MS);
  timer.unref?.();
  pendingChangeTimers.set(watched.syncKey, timer);
}

function handleLinkedDbEvaluationError(
  watched: WatchedDbDir,
  error: unknown,
  context: string,
): void {
  const message = (error as Error).message;
  if (isSqliteBusyError(error)) {
    console.warn(
      `[TursoLinkedDbWatcher] DB busy, deferring ${context} for ${watched.syncKey}`,
    );
    return;
  }
  if (isTursoLocalDatabaseCorruptError(message)) {
    recordTursoPushQuarantine(watched.syncKey, watched.dbPath, message);
    return;
  }
  console.warn(
    `[TursoLinkedDbWatcher] ${context} failed for ${watched.syncKey}:`,
    message,
  );
}

function evaluateDbChange(watched: WatchedDbDir): void {
  if (!isTursoStateDbPathInWorkspace(watched.dbPath)) {
    return;
  }

  void import("./tursoReplica/tursoReplicaRouting.js").then(
    ({ shouldSuppressLegacyTursoPush }) => {
      if (
        shouldSuppressLegacyTursoPush({
          syncKey: watched.syncKey,
          dbPath: watched.dbPath,
          dbId: watched.dbId,
        })
      ) {
        evaluateDbChangeReplica(watched);
        return;
      }
      void import("../utils/tursoReplicaEnabled.js").then(
        ({ isLegacyWorkspaceRowSyncEnabled }) => {
          if (!isLegacyWorkspaceRowSyncEnabled()) {
            return;
          }
          evaluateDbChangeLegacy(watched);
        },
      );
    },
  );
}

function scheduleReplicaPushFromWatcher(
  watched: WatchedDbDir,
  trigger: "watcher" | "completion" = "watcher",
): void {
  void import("./tursoReplica/tursoReplicaPushScheduler.js").then(
    ({ scheduleTursoReplicaPushForSyncKey }) => {
      scheduleTursoReplicaPushForSyncKey(watched.syncKey, "normal", trigger);
    },
  );
}

function evaluateDbChangeReplica(watched: WatchedDbDir): void {
  const coordinator = getSyncCoordinator();
  if (coordinator) {
    const status = coordinator.getStatus();
    if (status.activeFlush || status.inFlightAppIds.length > 0) {
      return;
    }
  }
  scheduleReplicaPushFromWatcher(watched);
  publishDbChanged({
    ...(watched.jobId ? { jobId: watched.jobId } : {}),
    ...(watched.dbId ? { dbId: watched.dbId } : {}),
  });
}

function evaluateDbChangeLegacy(watched: WatchedDbDir): void {
  const syncState = loadTursoSyncState();
  if (isJobDbQuarantined(watched.syncKey, syncState)) {
    return;
  }

  try {
    ensureLocalDbChangeLogReady(watched.dbPath);

    if (!localDbHasSyncableUserTables(watched.dbPath)) {
      return;
    }

    if (!hasUnpushedLocalDbChanges(watched.syncKey, watched.dbPath, syncState)) {
      clearStaleDirtyFlagIfClean(watched.syncKey, watched.dbPath);
      return;
    }
  } catch (error) {
    handleLinkedDbEvaluationError(watched, error, "db evaluation");
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
  const { isLegacyWorkspaceRowSyncEnabled, isTursoReplicaSyncFeatureEnabled } =
    await import("../utils/tursoReplicaEnabled.js");
  if (!isLegacyWorkspaceRowSyncEnabled() && !isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

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

  // One non-recursive OS watch per linked data dir (was chokidar depth:0 —
  // which still opened one kqueue fd per file in each dir).
  watcher = new TreeWatcher({
    roots: watchDirs,
    recursive: false,
    settleMs: 2_000, // was awaitWriteFinish.stabilityThreshold
    onEvent: (event) => handleDbChange(event.path),
    onError: (err, root) =>
      console.warn(`[TursoLinkedDbWatcher] Watch error for ${root}:`, err?.message ?? String(err)),
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

export function isTursoLinkedDbWatcherActive(): boolean {
  return watcher !== null;
}

export async function stopTursoLinkedDbWatcher(): Promise<void> {
  for (const timer of pendingChangeTimers.values()) {
    clearTimeout(timer);
  }
  pendingChangeTimers.clear();
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
export function evaluateDbChangeForTests(watched: WatchedDbDir): void {
  evaluateDbChange(watched);
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
