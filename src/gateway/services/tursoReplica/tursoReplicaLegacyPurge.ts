/**
 * Plan A — remove legacy sync-path artifacts from replica files without reseeding app data.
 * Preserves user tables; drops CDC/log tables, triggers, and stale sidecar metadata.
 */

import * as fs from "fs";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import {
  listLegacySyncPathTablesForPath,
  stripLegacySyncPathArtifacts,
} from "../legacyCdcArtifacts.js";
import { clearLegacyTursoSyncStateForDbPath, hasLegacyTursoSyncStateForDbPath } from "../tursoSyncState.js";
import { getTursoReplicaService } from "./TursoReplicaService.js";
import { pullLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import type { AppDataSource } from "../appDataSources.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import {
  detectReplicaSidecarWedge,
  repairReplicaSidecarWedge,
} from "./tursoReplicaSidecarWedge.js";

function recordAsDataSource(record: DatabaseRecord): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    alias: record.dbId,
    dbId: record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

export interface ReplicaLegacyPurgeResult {
  dbId: string;
  droppedTables: string[];
  clearedLegacySyncState: number;
  resetSidecars: boolean;
  pulled: boolean;
  skippedReason?: string;
}

/** Drop legacy sync tables/triggers and repair sidecars — keeps user app tables. */
export async function purgeLegacySyncPathForReplicaRecord(
  record: DatabaseRecord,
): Promise<ReplicaLegacyPurgeResult> {
  const dbPath = record.localPath;
  if (!dbPath?.trim() || !fs.existsSync(dbPath)) {
    return {
      dbId: record.dbId,
      droppedTables: [],
      clearedLegacySyncState: 0,
      resetSidecars: false,
      pulled: false,
      skippedReason: "missing_db_file",
    };
  }

  const replica = getTursoReplicaService();
  await replica.close(dbPath);

  // This function only ever runs against `syncMode === "replica"` records, where
  // `turso_cdc`, `turso_cdc_version`, and `turso_sync_last_change_id` are the engine's
  // live bookkeeping rather than legacy debris. Dropping them here made every gateway
  // startup discard the engine's sync cursor, and left a window in which something else
  // could recreate one with the wrong shape — which aborts the sync worker.
  const droppedTables = stripLegacySyncPathArtifacts(dbPath, {
    preserveEngineTables: true,
  });
  const clearedLegacySyncState = clearLegacyTursoSyncStateForDbPath(dbPath);

  let resetSidecars = false;
  if (detectReplicaSidecarWedge(dbPath)) {
    repairReplicaSidecarWedge(dbPath);
    resetSidecars = true;
  }

  let pulled = false;
  if (isTursoReplicaOnline()) {
    try {
      pulled = await pullLinkedDbViaTursoReplica(recordAsDataSource(record), {
        forceReconnect: true,
      });
    } catch (error) {
      console.warn(
        `[TursoReplicaLegacyPurge] Pull after purge failed for ${record.dbId}: ` +
          `${(error as Error).message.slice(0, 160)}`,
      );
    }
  }

  return {
    dbId: record.dbId,
    droppedTables,
    clearedLegacySyncState,
    resetSidecars,
    pulled,
  };
}

/** Gateway startup — purge legacy contamination from all active replica registry DBs. */
export async function purgeLegacySyncPathForAllReplicas(options?: {
  dbId?: string;
}): Promise<ReplicaLegacyPurgeResult[]> {
  const { initializeDatabaseRegistry } = await import("../DatabaseRegistryService.js");
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  let records = registry.listActive().filter((record) => record.syncMode === "replica");
  if (options?.dbId) {
    records = records.filter((record) => record.dbId === options.dbId);
  }

  const results: ReplicaLegacyPurgeResult[] = [];
  for (const record of records) {
    // Same scope as the purge itself. Without this the engine's own tables always
    // counted as "legacy present", so this guard never short-circuited and a healthy
    // replica was closed, purged, and re-pulled on every single startup.
    const legacyTables = listLegacySyncPathTablesForPath(record.localPath, {
      preserveEngineTables: true,
    });
    const needsSidecarRepair = detectReplicaSidecarWedge(record.localPath);
    const hasLegacyState = hasLegacyTursoSyncStateForDbPath(record.localPath);

    if (legacyTables.length === 0 && !needsSidecarRepair && !hasLegacyState) {
      continue;
    }

    const result = await purgeLegacySyncPathForReplicaRecord(record);
    results.push(result);

    if (result.droppedTables.length > 0 || result.resetSidecars) {
      console.log(
        `[TursoReplicaLegacyPurge] ${record.dbId}: dropped=` +
          `${result.droppedTables.join(",") || "none"} ` +
          `sidecarsReset=${result.resetSidecars} legacyStateCleared=${result.clearedLegacySyncState}`,
      );
    }
  }

  return results;
}
