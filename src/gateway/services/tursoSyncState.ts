/**
 * Tracks last successful Turso push per linked job (fingerprint-based dirty detection).
 * State file: ~/Papr/data/.turso-sync-state.json
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeSyncableTableFingerprintsForPath,
  fingerprintsEqual,
} from "./tursoTableFingerprint.js";

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
  /** When set, Turso push/pull is skipped until the local DB is repaired. */
  quarantinedAt?: string;
  quarantineReason?: string;
}

export interface TursoSyncStateFile {
  jobs: Record<string, TursoJobPushState>;
}

function defaultState(): TursoSyncStateFile {
  return { jobs: {} };
}

export function resolveTursoSyncStatePath(paprDir?: string): string {
  const root = paprDir ?? path.join(os.homedir(), "Papr");
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

export function isJobDbDirty(
  jobId: string,
  dbPath: string,
  state: TursoSyncStateFile,
): boolean {
  if (isJobDbQuarantined(jobId, state)) {
    return false;
  }

  const normalizedPath = path.normalize(dbPath);
  if (!fs.existsSync(normalizedPath)) {
    return false;
  }

  const prev = state.jobs[jobId];
  if (!prev) {
    return true;
  }
  if (path.normalize(prev.dbPath) !== normalizedPath) {
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
  };
  saveTursoSyncState(state, paprDir);
}
