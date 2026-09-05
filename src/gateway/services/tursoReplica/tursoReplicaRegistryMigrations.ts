/**
 * Apply registry migrations on Plan A replica DBs via papr_db / @tursodatabase/sync only.
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import type { AppDataSource } from "../appDataSources.js";
import { paprDbApplyMigration } from "./PaprDbService.js";
import { queryLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import { migrationSatisfiedOnReplica } from "./tursoReplicaMigrationVerify.js";

function recordAsSource(record: DatabaseRecord): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    dbId: record.dbId,
    alias: record.label ?? record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

async function listAppliedMigrationIds(source: AppDataSource): Promise<Set<string>> {
  try {
    const result = await queryLinkedDbViaTursoReplica(
      source,
      "SELECT id FROM schema_migrations",
      [],
      { pullBeforeRead: false },
    );
    return new Set(
      result.rows
        .map((row) => String(row.id ?? row[0] ?? ""))
        .filter((id) => id.length > 0),
    );
  } catch {
    return new Set();
  }
}

/** Apply pending migrations/*.sql via replica engine (no better-sqlite3). */
export async function applyReplicaRegistryDatabaseMigrations(
  migrationRoot: string,
  dbPath: string,
): Promise<string[]> {
  const registry = getDatabaseRegistryService();
  const record = registry.getByPath(dbPath);
  if (!record) {
    throw new Error(`Replica registry DB not found for path: ${dbPath}`);
  }

  const migrationsDir = path.join(migrationRoot, "migrations");
  await fs.mkdir(migrationsDir, { recursive: true });

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    return [];
  }

  const source = recordAsSource(record);
  const appliedIds = await listAppliedMigrationIds(source);
  const appliedNow: string[] = [];

  for (const fileName of files) {
    const bareId = fileName.replace(/\.sql$/, "");
    const ledgerSaysApplied = appliedIds.has(fileName) || appliedIds.has(bareId);
    if (ledgerSaysApplied) {
      const satisfied = await migrationSatisfiedOnReplica(source, migrationRoot, bareId);
      if (satisfied) {
        continue;
      }
      console.warn(
        `[TursoReplica] Migration ${bareId} is in schema_migrations but missing on the replica handle — re-applying`,
      );
    }

    const result = await paprDbApplyMigration({
      dbId: record.dbId,
      migrationId: fileName,
    });
    if (result.applied) {
      appliedNow.push(fileName);
      appliedIds.add(fileName);
      appliedIds.add(bareId);
    }
  }

  return appliedNow;
}
