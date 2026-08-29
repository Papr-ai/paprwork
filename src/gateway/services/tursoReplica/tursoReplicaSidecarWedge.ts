/**
 * Detect Turso Sync sidecar metadata drift (empty WAL vs non-zero watermark).
 */

import * as fs from "fs";

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
