/**
 * A park that outlives the process, for replicas whose own bytes abort the engine.
 *
 * An in-memory park stops the abort loop within a session, but a relaunch forgets it: the
 * worker opens the same unchanged file, aborts once more — a fresh crash report every
 * launch — and only then parks it again. When the chooser parks because of what is *in*
 * `data.db`, the next open of that same file will abort the same way, so the park is
 * recorded beside it and honoured before the native engine is allowed to touch it.
 *
 * Only file-evidence parks are recorded. A crash-streak park has no known cause and may be
 * a fault that a clean process clears, so persisting it could strand a healthy database.
 *
 * The record is scoped to the exact file it condemned, not to the path. Size and mtime of
 * `data.db` and its WAL are the fingerprint: a re-seed from cloud, a restore from backup or
 * any write replaces them, and the record stops applying — one open is attempted again,
 * because the evidence was about bytes that are no longer there. A TTL bounds the rest: a
 * park caused by the remote sending a defect leaves the local file unchanged, and without
 * an expiry a remote that was since fixed would never be retried.
 *
 * It lives outside `data.db` for the same reason as the bootstrap marker: a damaged
 * database must not be the thing that says whether it is damaged.
 */

import * as fs from "fs";

const PARK_SUFFIX = "-papr-parked";

/** Long enough that relaunches within a day cost nothing; short enough to retry a fixed remote. */
export const DURABLE_PARK_TTL_MS = 24 * 60 * 60 * 1000;

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

interface DurableParkRecord {
  reason: string;
  parkedAtMs: number;
  db: FileFingerprint;
  wal: FileFingerprint | null;
}

export function durableParkPath(localPath: string): string {
  return `${localPath}${PARK_SUFFIX}`;
}

function fingerprint(filePath: string): FileFingerprint | null {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameFingerprint(
  a: FileFingerprint | null,
  b: FileFingerprint | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/**
 * Record that this exact file aborts the engine. Never throws: failing to persist the park
 * costs one more abort on the next launch, which is the behaviour without this module, and
 * an exception here would replace the crash error the caller is classifying.
 */
export function writeDurablePark(
  localPath: string,
  reason: string,
  nowMs: number = Date.now(),
): void {
  const db = fingerprint(localPath);
  if (db === null) {
    return;
  }
  const record: DurableParkRecord = {
    reason,
    parkedAtMs: nowMs,
    db,
    wal: fingerprint(`${localPath}-wal`),
  };
  try {
    fs.writeFileSync(durableParkPath(localPath), JSON.stringify(record), "utf8");
  } catch (error) {
    console.warn(
      `[TursoSyncWorker] Could not persist the park for ${localPath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "The next launch will open it once more before parking again.",
    );
  }
}

/**
 * The reason this file is parked, or null if no record applies to it any more.
 *
 * A record that no longer matches the file, has expired, or cannot be parsed is deleted, so
 * a stale park is retried exactly once rather than consulted forever.
 */
export function readDurablePark(
  localPath: string,
  nowMs: number = Date.now(),
): string | null {
  const markerPath = durableParkPath(localPath);
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return null;
  }

  let record: Partial<DurableParkRecord>;
  try {
    record = JSON.parse(raw) as Partial<DurableParkRecord>;
  } catch {
    removeQuietly(markerPath);
    return null;
  }

  const valid =
    typeof record.reason === "string" &&
    typeof record.parkedAtMs === "number" &&
    record.db !== undefined &&
    nowMs - record.parkedAtMs < DURABLE_PARK_TTL_MS &&
    sameFingerprint(record.db, fingerprint(localPath)) &&
    sameFingerprint(record.wal ?? null, fingerprint(`${localPath}-wal`));

  if (!valid) {
    removeQuietly(markerPath);
    return null;
  }
  return record.reason ?? null;
}
