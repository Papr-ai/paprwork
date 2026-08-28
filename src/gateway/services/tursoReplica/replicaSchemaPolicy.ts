/**
 * Plan A schema authority — when cloud sync + replica rollout are active,
 * schema changes go through local Turso Sync replica exec + push via papr_db_apply_migration.
 */

import {
  SCHEMA_REQUIRES_ONLINE_MSG,
  SCHEMA_VIA_MIGRATION_MSG,
} from "../../../core/utils/planADbMessages.js";
import { isCloudSyncEnabled } from "../../utils/cloudSyncEnabled.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import { isDdlSql } from "./tursoReplicaPrimaryWrite.js";

export { SCHEMA_REQUIRES_ONLINE_MSG, SCHEMA_VIA_MIGRATION_MSG };

/** Cloud sync + Turso replica rollout — schema via local replica migrations. */
export function isPlanACloudDbAuthority(): boolean {
  return isCloudSyncEnabled() && isTursoReplicaSyncFeatureEnabled();
}

export function assertPaprDbExecAllowed(sql: string): void {
  if (!isPlanACloudDbAuthority()) {
    return;
  }
  if (isDdlSql(sql)) {
    throw new Error(SCHEMA_VIA_MIGRATION_MSG);
  }
}

export function assertPaprDbMigrationApplyAllowed(): void {
  // Offline provisional migrations are allowed (Phase 2) — pendingPush until reconnect.
}

export function assertReplicaDdlAllowed(sql: string): void {
  if (!isPlanACloudDbAuthority() || !isDdlSql(sql)) {
    return;
  }
  if (!isTursoReplicaOnline()) {
    throw new Error(SCHEMA_REQUIRES_ONLINE_MSG);
  }
}
