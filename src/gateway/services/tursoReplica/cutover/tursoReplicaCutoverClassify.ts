/**
 * Classify legacy registry databases into cutover buckets (B/C/D).
 */

import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import { isCloudSyncEnabled } from "../../../utils/cloudSyncEnabled.js";
import {
  isTursoReplicaSyncFeatureEnabled,
  shouldRunReplicaCutover,
} from "../../../utils/tursoReplicaEnabled.js";
import { snapshotLegacyRecordForCutover } from "./tursoReplicaCutoverSnapshot.js";
import type {
  CutoverBucket,
  CutoverClassification,
} from "./tursoReplicaCutoverTypes.js";
import { isRemoteAheadSchemaDrift } from "./tursoReplicaCutoverMigrationAuthority.js";

function bucketReason(
  bucket: CutoverBucket,
  detail: string,
): string {
  return `[${bucket}] ${detail}`;
}

/** Classify one registry record for legacy → replica cutover. */
export async function classifyRecordForReplicaCutover(
  record: DatabaseRecord,
): Promise<CutoverClassification> {
  const snapshot = await snapshotLegacyRecordForCutover(record);

  if (record.syncMode === "replica") {
    return {
      dbId: record.dbId,
      bucket: "skip",
      reason: bucketReason("skip", "Already syncMode=replica"),
      snapshot,
    };
  }

  if (!shouldRunReplicaCutover()) {
    return {
      dbId: record.dbId,
      bucket: "skip",
      reason: bucketReason(
        "skip",
        "Replica cutover rollout inactive (PAPR_TURSO_REPLICA_SYNC)",
      ),
      snapshot,
    };
  }

  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    return {
      dbId: record.dbId,
      bucket: "cloud_off",
      reason: bucketReason("cloud_off", "Cloud sync or Plan A rollout disabled"),
      snapshot,
    };
  }

  if (record.cutoverBlocked) {
    return {
      dbId: record.dbId,
      bucket: "blocked",
      reason: bucketReason(
        "blocked",
        record.cutoverBlockReason ??
          "Cutover previously blocked — repair then retry",
      ),
      snapshot,
    };
  }

  if (snapshot.quarantined) {
    return {
      dbId: record.dbId,
      bucket: "blocked",
      reason: bucketReason("blocked", "Database quarantined — repair required"),
      snapshot,
    };
  }

  if (snapshot.migrationConflict) {
    return {
      dbId: record.dbId,
      bucket: "blocked",
      reason: bucketReason(
        "blocked",
        snapshot.migrationConflictReason ??
          "Migration ledger conflict — repair required",
      ),
      snapshot,
    };
  }

  if (snapshot.remoteCheckFailed) {
    return {
      dbId: record.dbId,
      bucket: "blocked",
      reason: bucketReason(
        "blocked",
        snapshot.localTableCount > 0
          ? "Could not verify Turso remote state while local data exists"
          : "Could not verify Turso remote state — retry when online",
      ),
      snapshot,
    };
  }

  if (isRemoteAheadSchemaDrift(snapshot)) {
    return {
      dbId: record.dbId,
      bucket: "blocked",
      reason: bucketReason(
        "blocked",
        "Schema drift — Turso primary is ahead of local migration ledger",
      ),
      snapshot,
    };
  }

  if (snapshot.remoteTableCount === 0 && snapshot.localTableCount > 0) {
    return {
      dbId: record.dbId,
      bucket: "seed_local",
      reason: bucketReason(
        "seed_local",
        "Remote empty — seed Turso from local legacy file",
      ),
      snapshot,
    };
  }

  if (snapshot.remoteTableCount > 0) {
    return {
      dbId: record.dbId,
      bucket: "pull_remote",
      reason: bucketReason(
        "pull_remote",
        snapshot.dirty
          ? "Turso has data — in-place attach with pull-only (no full reseed)"
          : "Turso has data — in-place attach with pull-only",
      ),
      snapshot,
    };
  }

  return {
    dbId: record.dbId,
    bucket: "seed_local",
    reason: bucketReason("seed_local", "Both sides empty — provision replica"),
    snapshot,
  };
}
