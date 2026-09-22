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
 * A "wedge" is when `data.db-info` carries a `revert_since_wal_watermark` that names a frame
 * the `data.db-wal` does not contain. The engine resolves that watermark through
 * `WalFile::find_frame`, which asserts the frame exists — an unsatisfiable watermark is a Rust
 * `panic!`, and a panic inside the napi worker aborts the whole process rather than surfacing a
 * catchable error. Detection is therefore a precondition check, not error handling: once pull()
 * runs it is already too late.
 *
 * Repair resets only Plan A sidecars (keeps data.db), so the next connect re-bootstraps WAL
 * state from Turso.
 */

import * as fs from "fs";
import { removeTursoReplicaSidecarsOnly } from "./tursoReplicaFileGuard.js";
import {
  countUserRows,
  writeBootstrapPendingMarker,
  type BootstrapPendingReason,
} from "./tursoReplicaBootstrapMarker.js";
import { readReplicaWalShape } from "./tursoReplicaWalFrames.js";

interface ReplicaSidecarInfo {
  revertSinceWalWatermark: number;
  /** Remote revision marker, *not* a local WAL frame index — never gates a wedge. */
  walFragmentNo: number;
}

export type ReplicaSidecarWedgeReason =
  | "ok"
  | "missing_db"
  | "no_sidecar_info"
  | "wal_unreadable"
  | "watermark_past_wal_end";

export interface ReplicaSidecarWedgeReport {
  wedged: boolean;
  reason: ReplicaSidecarWedgeReason;
  watermark: number;
  walFrameCount: number;
  walSizeBytes: number;
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

/**
 * Report whether the sync engine would be asked to resolve a WAL frame that is not there.
 *
 * Deliberately narrow. Repair deletes sidecars and forces a re-bootstrap from Turso, so a false
 * positive is expensive: it throws away local WAL state on a database that was fine. We only
 * report a wedge when the WAL is parseable *and* provably too short for the recorded watermark.
 *
 * In particular a checkpointed (empty) WAL alongside a non-zero `wal_fragment_no` is the normal
 * resting state of a healthy replica — `wal_fragment_no` tracks the remote revision, not local
 * frames, so it says nothing about whether `find_frame` can be satisfied.
 */
export function inspectReplicaSidecarWedge(
  dbPath: string,
): ReplicaSidecarWedgeReport {
  const base: ReplicaSidecarWedgeReport = {
    wedged: false,
    reason: "ok",
    watermark: 0,
    walFrameCount: 0,
    walSizeBytes: 0,
  };

  if (!fs.existsSync(dbPath)) {
    return { ...base, reason: "missing_db" };
  }

  const info = readReplicaSidecarInfo(dbPath);
  if (!info) {
    return { ...base, reason: "no_sidecar_info" };
  }

  const wal = readReplicaWalShape(dbPath);
  const watermark = info.revertSinceWalWatermark;

  if (watermark <= 0) {
    // Nothing to revert — find_frame is never asked for a watermark frame.
    return {
      ...base,
      watermark,
      walFrameCount: wal.frameCount,
      walSizeBytes: wal.sizeBytes,
    };
  }

  if (!wal.frameCountKnown) {
    // Can't parse the WAL, so we can't prove the watermark is unsatisfiable.
    // Leaving it alone is the safe call; a real wedge still trips the checkpoint-error path.
    return {
      ...base,
      reason: "wal_unreadable",
      watermark,
      walSizeBytes: wal.sizeBytes,
    };
  }

  if (watermark > wal.frameCount) {
    return {
      wedged: true,
      reason: "watermark_past_wal_end",
      watermark,
      walFrameCount: wal.frameCount,
      walSizeBytes: wal.sizeBytes,
    };
  }

  return {
    ...base,
    watermark,
    walFrameCount: wal.frameCount,
    walSizeBytes: wal.sizeBytes,
  };
}

/** One-line diagnostic for logs — explains *why* sidecars are being reset. */
export function describeReplicaSidecarWedge(
  report: ReplicaSidecarWedgeReport,
): string {
  return (
    `${report.reason} (watermark=${report.watermark}, ` +
    `walFrames=${report.walFrameCount}, walBytes=${report.walSizeBytes})`
  );
}

/**
 * Sync engine metadata names a WAL frame the sync WAL does not contain.
 * Reads via sqlite3/better-sqlite3 still work; pull()/push() abort the process.
 */
export function detectReplicaSidecarWedge(dbPath: string): boolean {
  return inspectReplicaSidecarWedge(dbPath).wedged;
}

/**
 * Reset @tursodatabase/sync sidecars when the recorded watermark is unsatisfiable.
 * Keeps data.db intact — next pull reconnects from Turso.
 */
export function repairReplicaSidecarWedge(dbPath: string): boolean {
  if (!detectReplicaSidecarWedge(dbPath)) {
    return false;
  }
  // Marker first, delete second: a crash between the two costs one redundant pull, whereas
  // the reverse order is exactly the silent-empty-replica bug this guards against.
  writeBootstrapPendingMarker(dbPath, "sidecar_wedge_repair");
  removeTursoReplicaSidecarsOnly(dbPath);
  return true;
}

/**
 * What the caller observed, which decides whether the bootstrap marker is warranted.
 *
 * The distinction is the point: sidecar drift says nothing about `data.db`, so forcing a
 * populated replica through a destructive re-bootstrap buys nothing. An engine abort is
 * evidence about the process and possibly about the file, so it keeps the marker.
 */
export type SidecarResetCondition = "sidecar_drift" | "engine_panic";

/**
 * Reset sidecars, keeping the marker only when the replica cannot be shown to hold rows.
 *
 * Shared by the drift-detected paths rather than restated at each: the count must precede the
 * delete (rows living only in `-wal` are real rows, and counting after would read a populated
 * file as 0), and the marker must precede it too (a crash between them costs one redundant
 * pull, whereas the reverse leaves a sidecar-less empty replica nothing will ever seed).
 *
 * Empty and unreadable both keep the marker. `countUserRows` returns -1 for unreadable and
 * documents it as "unknown, never empty" — it is equally not evidence of "populated", so the
 * conservative branch is correct for it.
 */
function resetSidecarsPreservingPopulatedReplica(
  dbPath: string,
  reason: BootstrapPendingReason,
): void {
  const rows = countUserRows(dbPath);
  if (rows <= 0) {
    writeBootstrapPendingMarker(dbPath, reason);
  }
  removeTursoReplicaSidecarsOnly(dbPath);
}

/**
 * Delete Plan A sidecars for a path the caller has already inspected and closed.
 *
 * Split from {@link repairReplicaSidecarWedge} so the pre-sync path can inspect once, close the
 * open handle, then repair — unlinking a `-wal` that the engine still has open corrupts it.
 *
 * `condition` is required rather than defaulted because the two callers observed different
 * things and the safe answer differs: a defaulted parameter lets a new caller fall into the
 * wrong reading silently, and this function's own history is that both conditions shared one
 * behaviour and one reason for exactly that reason.
 */
export function resetReplicaSidecars(
  dbPath: string,
  condition: SidecarResetCondition,
): void {
  if (condition === "engine_panic") {
    // The engine aborted, so `data.db` is not above suspicion and the marker stays
    // unconditional — a redundant re-bootstrap is cheaper than serving a damaged file.
    writeBootstrapPendingMarker(dbPath, "engine_panic_sidecar_reset");
    removeTursoReplicaSidecarsOnly(dbPath);
    return;
  }
  resetSidecarsPreservingPopulatedReplica(dbPath, "pre_sync_sidecar_reset");
}

/**
 * After a sync-engine checkpoint/WAL error, reset Plan A sidecars (keep data.db).
 * Stronger than detect-only repair — the error itself signals metadata/WAL drift.
 *
 * The marker is written only when the file cannot be shown to hold rows, because the marker
 * is not free and the drift this repairs is in the sidecars rather than in data.db. A marker
 * forces the next `openSpec` onto the bootstrap path, which snapshots the whole file with
 * `VACUUM INTO`, re-downloads it, replays the snapshot back, and serves
 * "Replica bootstrap backoff active" to every read until that finishes — minutes of 503s on a
 * large replica whose rows were never in question.
 *
 * Skipping it leaves exactly the state {@link attachTursoReplicaInPlaceForCutover} creates
 * deliberately: sidecars gone, data.db populated, reconnect with `bootstrapIfEmpty: false`.
 * Its own contract is "attach to an existing data.db without re-downloading rows", so this is
 * a supported resting state and not a new one. The caller's immediate retry already runs that
 * way, since it reuses the spec computed before this call.
 *
 * Empty and unreadable both keep the marker. Empty is the silent-empty-replica case the marker
 * exists for: `openSpec` decides `bootstrapIfEmpty` from the file merely existing, so a
 * repaired-but-empty replica looks established and is never seeded. Unreadable is not evidence
 * of "populated" — per `countUserRows`, -1 means unknown and must never be read as empty, so
 * the conservative branch is the correct one for it too.
 *
 * Counting precedes the delete: rows that live only in `-wal` are real rows, and removing the
 * sidecar first would undercount a populated file to 0 — producing the marker this avoids.
 * Both callers close the worker handle before calling, so a -1 here means the file genuinely
 * cannot be read rather than that the engine is holding it.
 */
export function repairReplicaSidecarsOnCheckpointError(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  resetSidecarsPreservingPopulatedReplica(dbPath, "checkpoint_error_repair");
  return true;
}
