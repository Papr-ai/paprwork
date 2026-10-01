/**
 * Block collaborators from tombstoning publisher shared-primary registry rows
 * (local edit, agent delete, or metadata/git export).
 */

import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  shouldBlockTursoDeleteForSharedPrimary,
  TEAM_SHARED_REGISTRY_DELETE_MESSAGE,
} from "./appDeleteScope.js";
import type {
  DatabaseRecord,
  DatabasesRegistryFile,
} from "./DatabaseRegistryService.js";

export function assertMayTombstoneDatabaseRecord(
  record: DatabaseRecord,
  paprDir?: string,
): void {
  if (shouldBlockTursoDeleteForSharedPrimary(record.tursoShortName, paprDir)) {
    throw new Error(TEAM_SHARED_REGISTRY_DELETE_MESSAGE);
  }
}

/**
 * Strip unauthorized tombstones from the payload sent to cloud metadata.
 * Does not mutate the on-disk registry file.
 */
export function sanitizeDatabasesRegistryForCloudExport(
  registry: DatabasesRegistryFile,
  paprDir?: string,
): { registry: DatabasesRegistryFile; strippedDbIds: string[] } {
  const dir = paprDir ?? getPaprRoot();
  const strippedDbIds: string[] = [];
  const databases: Record<string, DatabaseRecord> = {};

  for (const [dbId, record] of Object.entries(registry.databases ?? {})) {
    if (!record) {
      continue;
    }
    if (
      record.status === "tombstone" &&
      shouldBlockTursoDeleteForSharedPrimary(record.tursoShortName, dir)
    ) {
      strippedDbIds.push(dbId);
      databases[dbId] = { ...record, status: "active" };
      continue;
    }
    databases[dbId] = record;
  }

  return {
    registry: { version: registry.version ?? 1, databases },
    strippedDbIds,
  };
}
