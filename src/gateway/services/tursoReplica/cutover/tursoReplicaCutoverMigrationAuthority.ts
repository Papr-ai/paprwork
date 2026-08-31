/**
 * Plan A cutover — preserve migration ledger, push local schema when ahead of Turso,
 * and repair ledger/schema mismatches after attach.
 */

import * as fs from "fs";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import { tursoNameForRecord } from "../../DatabaseRegistryService.js";
import { resolveMigrationRootFromDbPath } from "../../jobs/databaseMigrations.js";
import { applyPendingDatabaseMigrationsToTurso } from "../../jobs/jobMigrationTursoSync.js";
import { reconcileLocalMigrationLedgerFromSchema } from "../../jobs/jobMigrationLedgerSync.js";
import { ensureSchemaMigrationsTable } from "../../jobs/schemaMigrationsLedger.js";
import { getTursoSyncBridge } from "../../TursoSyncBridge.js";
import { isTursoReplicaOnline } from "../../../utils/tursoReplicaEnabled.js";
import {
  listLocalOnlyMigrationIds,
  readRemoteTursoMigrationIds,
} from "../tursoReplicaMigrationConflict.js";
import { applyReplicaRegistryDatabaseMigrations } from "../tursoReplicaRegistryMigrations.js";
import type { CutoverClassification, CutoverSnapshot } from "./tursoReplicaCutoverTypes.js";
import { preReplicaBackupPath } from "./tursoReplicaCutoverBackup.js";

function readMigrationIdsFromSqlite(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1",
        )
        .get() as { name: string } | undefined;
      if (!table) {
        return [];
      }
      const rows = db
        .prepare("SELECT id FROM schema_migrations ORDER BY id ASC")
        .all() as Array<{ id: string }>;
      return rows
        .map((row) => String(row.id ?? "").trim())
        .filter((id) => id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Merge schema_migrations rows from pre-cutover backup when strip removed the ledger. */
export function restoreMigrationLedgerFromBackup(
  dbPath: string,
  backupPath?: string,
): string[] {
  const sourceBackup = backupPath ?? preReplicaBackupPath(dbPath);
  if (!fs.existsSync(sourceBackup) || !fs.existsSync(dbPath)) {
    return [];
  }

  const backupIds = readMigrationIdsFromSqlite(sourceBackup);
  if (backupIds.length === 0) {
    return [];
  }

  const db = new Database(dbPath);
  const restored: string[] = [];
  try {
    ensureSchemaMigrationsTable(db);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
    );
    for (const id of backupIds) {
      const info = insert.run(id);
      if (info.changes > 0) {
        restored.push(id);
      }
    }
  } finally {
    db.close();
  }

  return restored;
}

/** True when local migration ledger or schema is ahead of Turso primary. */
export function needsLocalSchemaPushBeforeCutover(
  classification: CutoverClassification,
): boolean {
  const { snapshot, bucket } = classification;
  if (snapshot.remoteTableCount === 0) {
    return false;
  }
  if (bucket !== "pull_remote" && bucket !== "seed_local") {
    return false;
  }

  const localOnly = listLocalOnlyMigrationIds(
    snapshot.localMigrationIds,
    snapshot.remoteMigrationIds,
  );
  if (localOnly.length > 0) {
    return true;
  }

  return snapshot.schemaDrift && snapshot.localTableCount > 0;
}

/** Push pending local migrations to Turso primary before in-place attach + pull. */
export async function pushLocalSchemaToTursoBeforeCutover(
  record: DatabaseRecord,
): Promise<{ applied: string[]; skipped?: boolean; error?: string }> {
  if (!isTursoReplicaOnline()) {
    return { applied: [], skipped: true };
  }

  const migrationRoot = resolveMigrationRootFromDbPath(record.localPath);
  if (!migrationRoot) {
    return { applied: [], skipped: true };
  }

  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return { applied: [], error: "Turso sync bridge unavailable" };
  }

  const tursoDatabase = tursoNameForRecord(record);
  const creds = await bridge.fetchCredentials(tursoDatabase);
  const remote = createClient({
    url: creds.tursoUrl,
    authToken: creds.authToken,
  });

  try {
    const applied = await applyPendingDatabaseMigrationsToTurso(
      remote,
      record.localPath,
      migrationRoot,
    );
    return { applied };
  } catch (error) {
    return { applied: [], error: (error as Error).message };
  } finally {
    remote.close();
  }
}

/** After cutover attach: align ledger with schema and apply any still-pending git migrations. */
export async function repairReplicaMigrationAuthorityAfterCutover(
  record: DatabaseRecord,
): Promise<{ ledgerInferred: string[]; migrationsApplied: string[] }> {
  const migrationRoot = resolveMigrationRootFromDbPath(record.localPath);
  if (!migrationRoot || !fs.existsSync(record.localPath)) {
    return { ledgerInferred: [], migrationsApplied: [] };
  }

  const ledgerInferred = await reconcileLocalMigrationLedgerFromSchema(
    record.localPath,
    migrationRoot,
  );

  const migrationsApplied = await applyReplicaRegistryDatabaseMigrations(
    migrationRoot,
    record.localPath,
  );

  if (ledgerInferred.length > 0 || migrationsApplied.length > 0) {
    console.log(
      `[TursoReplicaCutover] Migration repair for ${record.dbId}: ` +
        `ledgerInferred=[${ledgerInferred.join(", ")}] ` +
        `applied=[${migrationsApplied.join(", ")}]`,
    );
  }

  return { ledgerInferred, migrationsApplied };
}

/** Gateway startup — heal ledger/schema drift on databases already on syncMode=replica. */
export async function repairAllReplicaMigrationAuthorityOnStartup(): Promise<number> {
  const { getDatabaseRegistryService, initializeDatabaseRegistry } = await import(
    "../../DatabaseRegistryService.js"
  );
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  const records = registry.listActive().filter((record) => record.syncMode === "replica");

  let repaired = 0;
  for (const record of records) {
    try {
      const result = await repairReplicaMigrationAuthorityAfterCutover(record);
      if (result.ledgerInferred.length > 0 || result.migrationsApplied.length > 0) {
        repaired += 1;
      }
    } catch (error) {
      console.warn(
        `[TursoReplicaCutover] Startup migration repair failed for ${record.dbId}: ` +
          `${(error as Error).message.slice(0, 160)}`,
      );
    }
  }

  if (repaired > 0) {
    console.log(
      `[TursoReplicaCutover] Startup migration repair completed for ${repaired} replica database(s)`,
    );
  }

  return repaired;
}

/**
 * Schema drift blocks cutover only when Turso is ahead — local-ahead drift is
 * repaired by pushing schema before attach.
 */
export function isRemoteAheadSchemaDrift(snapshot: CutoverSnapshot): boolean {
  if (!snapshot.schemaDrift || snapshot.legacyArtifactTables.length > 0) {
    return false;
  }
  if (snapshot.localTableCount === 0 || snapshot.remoteTableCount === 0) {
    return false;
  }

  const localSet = new Set(snapshot.localMigrationIds);
  const remoteOnly = snapshot.remoteMigrationIds.filter((id) => !localSet.has(id));
  const localOnly = listLocalOnlyMigrationIds(
    snapshot.localMigrationIds,
    snapshot.remoteMigrationIds,
  );

  return remoteOnly.length > 0 && localOnly.length === 0;
}

/** Refresh remote migration ids for cutover decisions (after schema push). */
export async function readRemoteMigrationIdsForRecord(
  record: DatabaseRecord,
): Promise<string[]> {
  try {
    return await readRemoteTursoMigrationIds(tursoNameForRecord(record));
  } catch {
    return [];
  }
}
