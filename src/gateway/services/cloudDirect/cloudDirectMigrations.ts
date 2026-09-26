/**
 * Migrations for cloud-direct databases: applied to the Turso primary, one
 * transaction per migration (statements + `_papr_schema_migrations` row
 * together), with the schema-checked "already done?" guard from
 * migrationStatementGuard. Same guarantees as the local and replica runners.
 */

import { promises as fs } from "fs";
import path from "path";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { cloudDirectClientForRecord } from "./cloudDirectDb.js";

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
  const applied: string[] = [];
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
