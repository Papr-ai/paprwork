/**
 * Migration ledger reconciliation before replica push (Plan A Phase 2).
 * Detects cloud-ahead conflicts after pull — fail loud instead of silent drift.
 */

import { createClient } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { queryLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";

export const MIGRATION_CONFLICT_CODE = "MIGRATION_CONFLICT";

export interface MigrationPushConflict {
  code: typeof MIGRATION_CONFLICT_CODE;
  message: string;
  localOnlyIds: string[];
  remoteOnlyIds: string[];
  cloudAheadIds: string[];
}

const SCHEMA_MIGRATIONS_QUERY =
  "SELECT id FROM schema_migrations ORDER BY id ASC";

function normalizeMigrationIds(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((row) => String(row.id ?? row[0] ?? "").trim())
    .filter((id) => id.length > 0);
}

/** Read migration ids from the local replica file (post-pull). */
export async function readLocalReplicaMigrationIds(
  source: AppDataSource,
): Promise<string[]> {
  try {
    const result = await queryLinkedDbViaTursoReplica(
      source,
      SCHEMA_MIGRATIONS_QUERY,
      [],
      { pullBeforeRead: false },
    );
    return normalizeMigrationIds(result.rows);
  } catch {
    return [];
  }
}

/** Read migration ids from Turso primary (HTTP). */
export async function readRemoteTursoMigrationIds(
  tursoDatabase: string,
): Promise<string[]> {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return [];
  }

  const creds = await bridge.fetchCredentials(tursoDatabase);
  const client = createClient({
    url: creds.tursoUrl,
    authToken: creds.authToken,
  });

  try {
    const result = await client.execute(SCHEMA_MIGRATIONS_QUERY);
    return normalizeMigrationIds(
      result.rows as Record<string, unknown>[],
    );
  } catch {
    return [];
  } finally {
    client.close();
  }
}

/**
 * Detect whether a push would apply provisional local migrations while cloud
 * schema has moved ahead (Spike 12).
 */
export function detectMigrationPushConflict(
  localIds: readonly string[],
  remoteIds: readonly string[],
): MigrationPushConflict | null {
  const remoteSet = new Set(remoteIds);
  const localSet = new Set(localIds);
  const localOnlyIds = localIds.filter((id) => !remoteSet.has(id));
  const remoteOnlyIds = remoteIds.filter((id) => !localSet.has(id));

  if (localOnlyIds.length === 0) {
    return null;
  }

  const maxRemote = remoteIds.reduce(
    (max, id) => (id > max ? id : max),
    "",
  );

  const cloudAheadIds = localOnlyIds.filter((id) => maxRemote > id);
  if (cloudAheadIds.length === 0) {
    return null;
  }

  const aheadLabel =
    remoteOnlyIds.length > 0
      ? remoteOnlyIds.join(", ")
      : maxRemote || "cloud head";

  return {
    code: MIGRATION_CONFLICT_CODE,
    message:
      `${MIGRATION_CONFLICT_CODE}: Cloud schema is ahead (${aheadLabel}). ` +
      `Replica migration(s) ${cloudAheadIds.join(", ")} must be rebased — ` +
      "use papr_db_migration_parity + papr_db_reconcile_sync or accept_cloud before push.",
    localOnlyIds,
    remoteOnlyIds,
    cloudAheadIds,
  };
}

export async function checkMigrationPushConflict(options: {
  source: AppDataSource;
  tursoDatabase: string;
}): Promise<MigrationPushConflict | null> {
  const [localIds, remoteIds] = await Promise.all([
    readLocalReplicaMigrationIds(options.source),
    readRemoteTursoMigrationIds(options.tursoDatabase),
  ]);
  return detectMigrationPushConflict(localIds, remoteIds);
}

/** Migration ids present locally but not yet on Turso primary. */
export function listLocalOnlyMigrationIds(
  localIds: readonly string[],
  remoteIds: readonly string[],
): string[] {
  const remoteSet = new Set(remoteIds);
  return localIds.filter((id) => !remoteSet.has(id));
}

export function hasLocalOnlyMigrationIds(
  localIds: readonly string[],
  remoteIds: readonly string[],
): boolean {
  return listLocalOnlyMigrationIds(localIds, remoteIds).length > 0;
}
