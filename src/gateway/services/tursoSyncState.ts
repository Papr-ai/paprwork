/**
 * Tracks last successful Turso push per linked job (fingerprint-based dirty detection).
 * State file: ~/Papr/data/.turso-sync-state.json
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import {
  computeSyncableTableFingerprintsForPath,
  fingerprintsEqual,
} from "./tursoTableFingerprint.js";
import { maxSyncLogId } from "./tursoSyncLog.js";
import Database from "better-sqlite3";

export const TURSO_SYNC_STATE_FILENAME = ".turso-sync-state.json";

export interface TursoJobPushState {
  dbPath: string;
  lastPushAt: string;
  /** @deprecated Legacy mtime-only dirty check; kept for migration reads. */
  dbMtimeMs?: number;
  /** Local syncable table name → content fingerprint at last successful push. */
  tableFingerprints?: Record<string, string>;
  /** Remote _papr_sync_meta version at last successful push or pull. */
  lastSeenRemoteVersion?: number;
  /** Highest local _papr_sync_log id included in last successful push. */
  lastPushedLogId?: number;
  /** Highest remote _papr_sync_log id applied in last successful pull. */
  lastPulledLogId?: number;
  /** Remote sync index version for this source's Turso short name (hint cursor). */
  lastSeenIndexVersion?: number;
  /** When set, Turso push/pull is skipped until the local DB is repaired. */
  quarantinedAt?: string;
  quarantineReason?: string;
  /** Instant dirty signal from watcher/coordinator (Phase 5 fast path). */
  dirtyFlag?: boolean;
  dirtyFlagAt?: string;
}

export interface TursoSyncStateFile {
  jobs: Record<string, TursoJobPushState>;
}

function defaultState(): TursoSyncStateFile {
  return { jobs: {} };
}

export function resolveTursoSyncStatePath(paprDir?: string): string {
  const root = paprDir ?? getPaprRoot();
  return path.join(root, "data", TURSO_SYNC_STATE_FILENAME);
}

export function loadTursoSyncState(paprDir?: string): TursoSyncStateFile {
  const statePath = resolveTursoSyncStatePath(paprDir);
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as TursoSyncStateFile;
    if (parsed && typeof parsed === "object" && parsed.jobs) {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return defaultState();
}

export function saveTursoSyncState(
  state: TursoSyncStateFile,
  paprDir?: string,
): void {
  const statePath = resolveTursoSyncStatePath(paprDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function readDbMtimeMs(dbPath: string): number | null {
  const normalized = path.normalize(dbPath);
  let maxMtime: number | null = null;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const mtimeMs = fs.statSync(normalized + suffix).mtimeMs;
      if (maxMtime === null || mtimeMs > maxMtime) {
        maxMtime = mtimeMs;
      }
    } catch {
      /* optional sidecar */
    }
  }
  return maxMtime;
}

export function resolveTursoPushStateKey(
  syncKey: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): string | undefined {
  const normalizedPath = path.normalize(dbPath);
  const keys = [
    syncKey,
    ...alternateKeys.filter((key) => key && key !== syncKey),
  ];
  for (const key of keys) {
    const entry = state.jobs[key];
    if (entry && path.normalize(entry.dbPath) === normalizedPath) {
      return key;
    }
  }
  return undefined;
}

export function resolveTursoPushStateEntry(
  syncKey: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): TursoJobPushState | undefined {
  const stateKey = resolveTursoPushStateKey(
    syncKey,
    dbPath,
    state,
    alternateKeys,
  );
  return stateKey ? state.jobs[stateKey] : undefined;
}

export function isJobDbDirty(
  jobId: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): boolean {
  if (isJobDbQuarantined(jobId, state)) {
    return false;
  }
  for (const key of alternateKeys) {
    if (key !== jobId && isJobDbQuarantined(key, state)) {
      return false;
    }
  }

  const normalizedPath = path.normalize(dbPath);
  if (!fs.existsSync(normalizedPath)) {
    return false;
  }

  const prev = resolveTursoPushStateEntry(jobId, dbPath, state, alternateKeys);
  if (!prev) {
    return true;
  }

  const currentFingerprints = computeSyncableTableFingerprintsForPath(normalizedPath);
  if (currentFingerprints === null) {
    return true;
  }

  if (prev.tableFingerprints) {
    return !fingerprintsEqual(currentFingerprints, prev.tableFingerprints);
  }

  // Legacy state without fingerprints — treat as dirty once, then fingerprint on push.
  const mtimeMs = readDbMtimeMs(normalizedPath);
  if (mtimeMs === null) {
    return false;
  }
  return prev.dbMtimeMs === undefined || mtimeMs > prev.dbMtimeMs;
}

/**
 * Content-based dirty check — ignores persisted dirtyFlag.
 * Used by the watcher so WAL/SHM touches do not mark clean DBs dirty.
 */
export function hasUnpushedLocalDbChanges(
  syncKey: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): boolean {
  if (isJobDbQuarantined(syncKey, state)) {
    return false;
  }
  for (const key of alternateKeys) {
    if (key !== syncKey && isJobDbQuarantined(key, state)) {
      return false;
    }
  }

  const normalizedPath = path.normalize(dbPath);
  if (!fs.existsSync(normalizedPath)) {
    return false;
  }

  const prev = resolveTursoPushStateEntry(syncKey, dbPath, state, alternateKeys);
  if (!prev) {
    return true;
  }

  const oplogDirty = isLinkedSourceDirtyFastIgnoringFlag(
    syncKey,
    dbPath,
    state,
    alternateKeys,
  );
  if (oplogDirty === true) {
    return true;
  }
  if (oplogDirty === false) {
    if (prev.tableFingerprints) {
      const currentFingerprints =
        computeSyncableTableFingerprintsForPath(normalizedPath);
      if (currentFingerprints === null) {
        return true;
      }
      return !fingerprintsEqual(currentFingerprints, prev.tableFingerprints);
    }
    return false;
  }

  return isJobDbDirty(syncKey, dbPath, state, alternateKeys);
}

/** Drop persisted dirtyFlag when oplog/fingerprints show no unpushed changes. */
export function clearStaleDirtyFlagIfClean(
  syncKey: string,
  dbPath: string,
  paprDir?: string,
  alternateKeys: readonly string[] = [],
): boolean {
  const state = loadTursoSyncState(paprDir);
  const stateKey = resolveTursoPushStateKey(syncKey, dbPath, state, alternateKeys);
  if (!stateKey) {
    return false;
  }
  const entry = state.jobs[stateKey];
  if (!entry?.dirtyFlag) {
    return false;
  }
  if (hasUnpushedLocalDbChanges(syncKey, dbPath, state, alternateKeys)) {
    return false;
  }
  delete entry.dirtyFlag;
  delete entry.dirtyFlagAt;
  saveTursoSyncState(state, paprDir);
  return true;
}

/** Mark linked source dirty from watcher or job completion (O(1)). */
export function markDbDirty(
  syncKey: string,
  dbPath: string,
  paprDir?: string,
): void {
  const normalizedPath = path.normalize(dbPath);
  const state = loadTursoSyncState(paprDir);
  if (!hasUnpushedLocalDbChanges(syncKey, normalizedPath, state)) {
    clearStaleDirtyFlagIfClean(syncKey, normalizedPath, paprDir);
    return;
  }

  const stateKey =
    resolveTursoPushStateKey(syncKey, normalizedPath, state) ?? syncKey;
  const existing = state.jobs[stateKey];
  if (existing?.dirtyFlag === true && existing.dbPath === normalizedPath) {
    return;
  }
  state.jobs[stateKey] = {
    dbPath: normalizedPath,
    lastPushAt: existing?.lastPushAt ?? new Date(0).toISOString(),
    dirtyFlag: true,
    dirtyFlagAt: new Date().toISOString(),
    ...(existing?.tableFingerprints
      ? { tableFingerprints: existing.tableFingerprints }
      : {}),
    ...(existing?.lastPushedLogId !== undefined
      ? { lastPushedLogId: existing.lastPushedLogId }
      : {}),
    ...(existing?.lastPulledLogId !== undefined
      ? { lastPulledLogId: existing.lastPulledLogId }
      : {}),
    ...(existing?.lastSeenRemoteVersion !== undefined
      ? { lastSeenRemoteVersion: existing.lastSeenRemoteVersion }
      : {}),
    ...(existing?.lastSeenIndexVersion !== undefined
      ? { lastSeenIndexVersion: existing.lastSeenIndexVersion }
      : {}),
  };
  saveTursoSyncState(state, paprDir);
}

export function clearDirtyAfterPush(syncKey: string, paprDir?: string): void {
  const state = loadTursoSyncState(paprDir);
  const entry = state.jobs[syncKey];
  if (!entry) {
    return;
  }
  delete entry.dirtyFlag;
  delete entry.dirtyFlagAt;
  saveTursoSyncState(state, paprDir);
}

export function listDbDirtySyncKeys(paprDir?: string): string[] {
  const state = loadTursoSyncState(paprDir);
  return Object.entries(state.jobs)
    .filter(([, entry]) => entry.dirtyFlag === true)
    .map(([syncKey]) => syncKey);
}

/**
 * Oplog cursor check only — ignores persisted dirtyFlag.
 * Returns true (dirty), false (clean), or null (needs fingerprint/mtime check).
 */
export function isLinkedSourceDirtyFastIgnoringFlag(
  syncKey: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): boolean | null {
  if (isJobDbQuarantined(syncKey, state)) {
    return false;
  }
  for (const key of alternateKeys) {
    if (key !== syncKey && isJobDbQuarantined(key, state)) {
      return false;
    }
  }

  const normalizedPath = path.normalize(dbPath);
  if (!fs.existsSync(normalizedPath)) {
    return false;
  }

  const prev = resolveTursoPushStateEntry(syncKey, dbPath, state, alternateKeys);
  if (!prev) {
    return true;
  }

  const lastPushed = prev.lastPushedLogId ?? 0;
  let db: Database.Database | undefined;
  try {
    db = new Database(normalizedPath, { readonly: true, fileMustExist: true });
    const maxId = maxSyncLogId(db);
    if (maxId > lastPushed) {
      return true;
    }
    if (maxId <= lastPushed) {
      return false;
    }
  } catch {
    return null;
  } finally {
    db?.close();
  }

  return null;
}

/**
 * Two-tier dirty check: dirty flag + oplog cursor before full fingerprints.
 * Returns true (dirty), false (clean), or null (needs full check).
 */
export function isLinkedSourceDirtyFast(
  syncKey: string,
  dbPath: string,
  state: TursoSyncStateFile,
  alternateKeys: readonly string[] = [],
): boolean | null {
  const prev = resolveTursoPushStateEntry(syncKey, dbPath, state, alternateKeys);
  if (prev?.dirtyFlag) {
    return true;
  }
  return isLinkedSourceDirtyFastIgnoringFlag(
    syncKey,
    dbPath,
    state,
    alternateKeys,
  );
}

export function isJobDbQuarantined(
  jobId: string,
  state: TursoSyncStateFile,
): boolean {
  return Boolean(state.jobs[jobId]?.quarantinedAt);
}

export function recordTursoPushQuarantine(
  jobId: string,
  dbPath: string,
  reason: string,
  paprDir?: string,
): void {
  const normalizedPath = path.normalize(dbPath);
  const state = loadTursoSyncState(paprDir);
  const existing = state.jobs[jobId];
  state.jobs[jobId] = {
    dbPath: normalizedPath,
    lastPushAt: existing?.lastPushAt ?? new Date().toISOString(),
    quarantinedAt: new Date().toISOString(),
    quarantineReason: reason.slice(0, 500),
    ...(existing?.tableFingerprints
      ? { tableFingerprints: existing.tableFingerprints }
      : {}),
  };
  saveTursoSyncState(state, paprDir);
  console.warn(
    `[TursoSync] Quarantined job ${jobId} (Turso sync paused): ${reason.slice(0, 120)}`,
  );
}

export function localDbHasSyncableData(dbPath: string): boolean {
  const fingerprints = computeSyncableTableFingerprintsForPath(dbPath);
  if (!fingerprints) {
    return false;
  }
  return Object.keys(fingerprints).length > 0;
}

export function recordTursoPushSuccess(
  jobId: string,
  dbPath: string,
  paprDir?: string,
  tableFingerprints?: Record<string, string>,
  lastPushedLogId?: number,
): void {
  const normalizedPath = path.normalize(dbPath);
  const fingerprints =
    tableFingerprints ?? computeSyncableTableFingerprintsForPath(normalizedPath);

  const state = loadTursoSyncState(paprDir);
  const existing = state.jobs[jobId];
  state.jobs[jobId] = {
    dbPath: normalizedPath,
    lastPushAt: new Date().toISOString(),
    dbMtimeMs: readDbMtimeMs(normalizedPath) ?? undefined,
    ...(fingerprints ? { tableFingerprints: fingerprints } : {}),
    ...(existing?.lastSeenRemoteVersion !== undefined
      ? { lastSeenRemoteVersion: existing.lastSeenRemoteVersion }
      : {}),
    ...(existing?.lastPulledLogId !== undefined
      ? { lastPulledLogId: existing.lastPulledLogId }
      : {}),
    ...(lastPushedLogId !== undefined ? { lastPushedLogId } : {}),
    ...(existing?.lastSeenIndexVersion !== undefined
      ? { lastSeenIndexVersion: existing.lastSeenIndexVersion }
      : {}),
  };
  saveTursoSyncState(state, paprDir);
}

export function clearTursoPushState(jobId: string, paprDir?: string): void {
  const state = loadTursoSyncState(paprDir);
  if (!state.jobs[jobId]) {
    return;
  }
  delete state.jobs[jobId];
  saveTursoSyncState(state, paprDir);
}

export function clearTursoQuarantine(jobId: string, paprDir?: string): void {
  const state = loadTursoSyncState(paprDir);
  const entry = state.jobs[jobId];
  if (!entry?.quarantinedAt) {
    return;
  }
  delete entry.quarantinedAt;
  delete entry.quarantineReason;
  saveTursoSyncState(state, paprDir);
}

export interface TursoJobDatabaseRepairResult {
  success: boolean;
  backedUpTo: string | null;
  message: string;
}

/**
 * Backup corrupt local job SQLite, remove it, and clear Turso quarantine so the
 * job can rebuild data on next run.
 */
export function repairTursoJobDatabase(
  jobId: string,
  dbPath: string,
  paprDir?: string,
): TursoJobDatabaseRepairResult {
  const normalizedPath = path.normalize(dbPath);
  const dataDir = path.dirname(normalizedPath);

  if (!fs.existsSync(normalizedPath)) {
    clearTursoQuarantine(jobId, paprDir);
    clearTursoPushState(jobId, paprDir);
    return {
      success: true,
      backedUpTo: null,
      message:
        "Database file not found — quarantine cleared. Re-run the job to create a fresh database.",
    };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupBase = path.join(dataDir, `data.db.corrupt-backup-${timestamp}`);
  fs.copyFileSync(normalizedPath, backupBase);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = normalizedPath + suffix;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, backupBase + suffix);
    }
  }

  fs.unlinkSync(normalizedPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = normalizedPath + suffix;
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
    }
  }

  clearTursoQuarantine(jobId, paprDir);
  clearTursoPushState(jobId, paprDir);

  return {
    success: true,
    backedUpTo: backupBase,
    message:
      "Corrupt database backed up and removed. Re-run the job to rebuild local data, then sync again.",
  };
}

/**
 * Record the remote sync version observed after a successful push or pull.
 * Used to skip redundant pulls with a single-row version check.
 */
export function recordTursoRemoteVersion(
  jobId: string,
  dbPath: string,
  version: number,
  paprDir?: string,
  options?: {
    lastPushedLogId?: number;
    lastPulledLogId?: number;
  },
): void {
  const state = loadTursoSyncState(paprDir);
  const existing = state.jobs[jobId];
  state.jobs[jobId] = {
    dbPath,
    lastPushAt: existing?.lastPushAt ?? new Date().toISOString(),
    ...(existing?.tableFingerprints
      ? { tableFingerprints: existing.tableFingerprints }
      : {}),
    ...(existing?.dbMtimeMs !== undefined ? { dbMtimeMs: existing.dbMtimeMs } : {}),
    lastSeenRemoteVersion: version,
    ...(options?.lastPushedLogId !== undefined
      ? { lastPushedLogId: options.lastPushedLogId }
      : existing?.lastPushedLogId !== undefined
        ? { lastPushedLogId: existing.lastPushedLogId }
        : {}),
    ...(options?.lastPulledLogId !== undefined
      ? { lastPulledLogId: options.lastPulledLogId }
      : existing?.lastPulledLogId !== undefined
        ? { lastPulledLogId: existing.lastPulledLogId }
        : {}),
    ...(existing?.lastSeenIndexVersion !== undefined
      ? { lastSeenIndexVersion: existing.lastSeenIndexVersion }
      : {}),
  };
  saveTursoSyncState(state, paprDir);
}

/** Record sync index version observed after successful push/pull or index reconcile. */
export function recordTursoIndexVersion(
  jobId: string,
  dbPath: string,
  version: number,
  paprDir?: string,
): void {
  const state = loadTursoSyncState(paprDir);
  const existing = state.jobs[jobId];
  state.jobs[jobId] = {
    dbPath,
    lastPushAt: existing?.lastPushAt ?? new Date().toISOString(),
    ...(existing?.tableFingerprints
      ? { tableFingerprints: existing.tableFingerprints }
      : {}),
    ...(existing?.dbMtimeMs !== undefined ? { dbMtimeMs: existing.dbMtimeMs } : {}),
    ...(existing?.lastSeenRemoteVersion !== undefined
      ? { lastSeenRemoteVersion: existing.lastSeenRemoteVersion }
      : {}),
    ...(existing?.lastPushedLogId !== undefined
      ? { lastPushedLogId: existing.lastPushedLogId }
      : {}),
    ...(existing?.lastPulledLogId !== undefined
      ? { lastPulledLogId: existing.lastPulledLogId }
      : {}),
    lastSeenIndexVersion: version,
  };
  saveTursoSyncState(state, paprDir);
}
