/**
 * Plan A @tursodatabase/sync sidecar wedge detection and one-time repair.
 *
 * Two different "sidecar" concepts:
 * - Legacy (cutover): `_papr_sync_log`, CDC tables, legacy sync state — stripped at cutover,
 *   not recreated. Safe to delete permanently.
 * - Plan A replica (required): `data.db-info`, `data.db-changes`, `data.db-wal`, `data.db-shm`,
 *   `data.db-wal-revert` — owned by @tursodatabase/sync. The SDK recreates them on connect;
 *   do not delete them in normal operation.
 *
 * A "wedge" is when Plan A metadata (-info) claims WAL progress but the sync WAL is empty.
 * That state wedges pull()/push(). Root cause: calling checkpoint() after push on replica files.
 * Repair resets only Plan A sidecars (keeps data.db) for already-wedged disks — not a startup scan.
 */

import * as fs from "fs";
import { removeTursoReplicaSidecarsOnly } from "./tursoReplicaFileGuard.js";

interface ReplicaSidecarInfo {
  revertSinceWalWatermark: number;
  walFragmentNo: number;
}

function readReplicaSidecarInfo(dbPath: string): ReplicaSidecarInfo | null {
  const infoPath = `${dbPath}-info`;
  if (!fs.existsSync(infoPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(infoPath, "utf8");
    const parsed = JSON.parse(raw) as {
      revert_since_wal_watermark?: unknown;
      synced_revision?: { revision?: unknown };
    };
    let walFragmentNo = 0;
    const revision = parsed.synced_revision?.revision;
    if (typeof revision === "string") {
      try {
        const rev = JSON.parse(revision) as { wal_fragment_no?: unknown };
        if (typeof rev.wal_fragment_no === "number") {
          walFragmentNo = rev.wal_fragment_no;
        }
      } catch {
        /* ignore malformed revision */
      }
    }
    const revertSinceWalWatermark =
      typeof parsed.revert_since_wal_watermark === "number"
        ? parsed.revert_since_wal_watermark
        : 0;
    return { revertSinceWalWatermark, walFragmentNo };
  } catch {
    return null;
  }
}

function localTursoSyncWalSize(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Sync engine metadata claims WAL progress but the Turso Sync WAL file is empty.
 * Reads via sqlite3/better-sqlite3 still work; pull()/push() wedge.
 */
export function detectReplicaSidecarWedge(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const walSize = localTursoSyncWalSize(dbPath);
  if (walSize > 0) {
    return false;
  }
  const info = readReplicaSidecarInfo(dbPath);
  if (!info) {
    return false;
  }
  return info.revertSinceWalWatermark > 0 || info.walFragmentNo > 0;
}

/**
 * Reset @tursodatabase/sync sidecars when metadata claims WAL progress but the sync WAL is empty.
 * Keeps data.db intact — next pull reconnects from Turso.
 */
export function repairReplicaSidecarWedge(dbPath: string): boolean {
  if (!detectReplicaSidecarWedge(dbPath)) {
    return false;
  }
  removeTursoReplicaSidecarsOnly(dbPath);
  return true;
}

/**
 * After a sync-engine checkpoint/WAL error, reset Plan A sidecars (keep data.db).
 * Stronger than detect-only repair — the error itself signals metadata/WAL drift.
 */
export function repairReplicaSidecarsOnCheckpointError(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  removeTursoReplicaSidecarsOnly(dbPath);
  return true;
}
