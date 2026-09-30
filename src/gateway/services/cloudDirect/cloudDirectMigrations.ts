/**
 * Migrations for cloud-direct databases: applied to the Turso primary, one
 * transaction per migration (statements + `_papr_schema_migrations` row
 * together), with the schema-checked "already done?" guard from
 * migrationStatementGuard. Same guarantees as the local and replica runners.
 */

import { promises as fs } from "fs";
import path from "path";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import type { Client } from "@libsql/client";
import { cloudDirectClientForRecord } from "./cloudDirectDb.js";

/**
 * Fresh primary + valid snapshot → schema, seed and ledger rows in one
 * transaction. Anything else (existing tables, ledger rows, no/invalid
 * snapshot) returns [] and normal per-migration replay runs.
 */
export async function applySnapshotToRemoteIfFresh(
  remote: Client,
  migrationRoot: string,
): Promise<string[]> {
  const { ensureRemoteSchemaMigrationsTable, REMOTE_SCHEMA_MIGRATIONS_TABLE } =
    await import("../jobs/jobMigrationLedgerSync.js");
  const { FRESH_TABLES_SQL, hasNoAppTables, planSnapshotInstall } = await import(
    "../jobs/schemaSnapshotApply.js"
  );
  const tables = await remote.execute(FRESH_TABLES_SQL);
  if (!hasNoAppTables(tables.rows.map((row) => String(row.name ?? "")))) {
    return [];
  }
  await ensureRemoteSchemaMigrationsTable(remote);
  const ledger = await remote.execute(
    `SELECT id FROM "${REMOTE_SCHEMA_MIGRATIONS_TABLE}"`,
  );
  const { isMigrationLedgerMarker } = await import("../jobs/migrationLedgerPolicy.js");
  if (
    ledger.rows.some(
      (row) => !isMigrationLedgerMarker(String(row.id ?? "").replace(/\.sql$/, "")),
    )
  ) {
    return [];
  }
  const plan = await planSnapshotInstall(migrationRoot);
  if (!plan) {
    return [];
  }
  await remote.batch(
    [
      ...plan.statements.map((sql) => ({ sql, args: [] })),
      ...plan.coveredIds.map((id) => ({
        sql:
          `INSERT OR IGNORE INTO "${REMOTE_SCHEMA_MIGRATIONS_TABLE}" ` +
          `(id, applied_at, source) VALUES (?, datetime('now'), 'schema_snapshot')`,
        args: [id],
      })),
    ],
    "write",
  );
  console.log(
    `[SchemaSnapshot] Built cloud database from snapshot (${plan.coveredIds.length} migrations covered)`,
  );
  return plan.coveredIds;
}

export async function applyCloudDirectMigrations(
  migrationRoot: string,
  dbPath: string,
): Promise<string[]> {
  const record = getDatabaseRegistryService().getByPath(dbPath);
  if (!record) {
    throw new Error(`Cloud-direct database not registered for path: ${dbPath}`);
  }

  const migrationsDir = path.join(migrationRoot, "migrations");
  let files: string[];
  try {
    files = (await fs.readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
  if (files.length === 0) {
    return [];
  }

  const { applyAndRecordMigrationOnTursoPrimary } = await import(
    "../jobs/jobMigrationTursoSync.js"
  );
  const remote = await cloudDirectClientForRecord(record);
  const applied: string[] = [
    ...(await applySnapshotToRemoteIfFresh(remote, migrationRoot)),
  ];
  for (const fileName of files) {
    const id = fileName.replace(/\.sql$/, "");
    try {
      const result = await applyAndRecordMigrationOnTursoPrimary(
        remote,
        migrationRoot,
        id,
      );
      if (result.applied) {
        applied.push(id);
      }
    } catch (error) {
      // Stop at the first failure: later migrations may depend on this one,
      // and the failed one rolled back cleanly (nothing half-applied).
      throw new Error(
        `Migration ${id} failed on cloud database ${record.label ?? record.dbId}: ` +
          (error as Error).message,
      );
    }
  }
  return applied;
}
