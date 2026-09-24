/**
 * Apply registry migrations on Plan A replica DBs via papr_db / @tursodatabase/sync only.
 *
 * This runs before every job run, so it has to be safe to call thousands of
 * times against a database full of live rows. When a migration may run again
 * is decided by tursoReplicaMigrationRerunPolicy.ts -- read that before
 * changing the loop below.
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import type { AppDataSource } from "../appDataSources.js";
import {
  isMissingTableError,
  migrationRerunSafety,
} from "../jobs/migrationSqlHelpers.js";
import { REMOTE_SCHEMA_MIGRATIONS_TABLE } from "../tursoPlatformSchema.js";
import { paprDbApplyMigration } from "./PaprDbService.js";
import { queryLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import { migrationSatisfiedOnReplica } from "./tursoReplicaMigrationVerify.js";
import {
  decideReplicaMigration,
  describeRefusedMigration,
  replicaMigrationNeedsVerification,
} from "./tursoReplicaMigrationRerunPolicy.js";

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

/**
 * Both ledgers. `_papr_schema_migrations` (written by papr_db migration tools,
 * stored on the Turso primary) survives a replica reseed; `schema_migrations`
 * rows are replica-local and do not.
 */
const LEDGER_TABLES = ["schema_migrations", REMOTE_SCHEMA_MIGRATIONS_TABLE] as const;

interface MigrationLedgers {
  /** Ids recorded in either ledger, spelled as stored (`0002_x` or `0002_x.sql`). */
  ids: Set<string>;
  /** False when a ledger exists but did not answer: absence then means "unknown". */
  readable: boolean;
  errors: string[];
}

async function readMigrationLedgers(source: AppDataSource): Promise<MigrationLedgers> {
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const table of LEDGER_TABLES) {
    try {
      const result = await queryLinkedDbViaTursoReplica(
        source,
        `SELECT id FROM "${table}"`,
        [],
        { pullBeforeRead: false },
      );
      for (const row of result.rows) {
        const id = String(row.id ?? row[0] ?? "").trim();
        if (id.length > 0) {
          ids.add(id);
        }
      }
    } catch (error) {
      // No ledger table at all is a fresh database, which is a real answer.
      if (isMissingTableError(error)) {
        continue;
      }
      errors.push(`${table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ids, readable: errors.length === 0, errors };
}

export interface ReplicaMigrationRunOptions {
  /**
   * Receives every warning and refusal, so the job's run log shows it rather
   * than only the gateway log.
   */
  onWarning?: (message: string) => void;
}

/** Apply pending migrations/*.sql via replica engine (no better-sqlite3). */
export async function applyReplicaRegistryDatabaseMigrations(
  migrationRoot: string,
  dbPath: string,
  options: ReplicaMigrationRunOptions = {},
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
  const dbLabel = record.label ?? record.dbId;
  const report = (message: string, level: "warn" | "error"): void => {
    if (level === "error") {
      console.error(message);
    } else {
      console.warn(message);
    }
    options.onWarning?.(message);
  };
  const verify = async (bareId: string): Promise<boolean> => {
    try {
      return await migrationSatisfiedOnReplica(source, migrationRoot, bareId);
    } catch (error) {
      // Unverifiable is not the same as unapplied: the policy then re-runs
      // only migrations that are safe to re-run.
      report(
        `[TursoReplica] Could not verify ${bareId} on ${dbLabel}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return false;
    }
  };

  const ledgers = await readMigrationLedgers(source);
  if (!ledgers.readable) {
    report(
      `[TursoReplica] Could not read the migration ledger of ${dbLabel} ` +
        `(${ledgers.errors.join("; ")}). Migrations that are unsafe to re-run ` +
        `are held until it can be read.`,
      "warn",
    );
  }
  const appliedNow: string[] = [];

  for (const fileName of files) {
    const bareId = fileName.replace(/\.sql$/, "");
    const recorded = ledgers.ids.has(fileName) || ledgers.ids.has(bareId);
    const safety = migrationRerunSafety(
      await fs.readFile(path.join(migrationsDir, fileName), "utf8"),
    );
    const satisfied = replicaMigrationNeedsVerification(recorded, ledgers.readable)
      ? await verify(bareId)
      : null;
    const decision = decideReplicaMigration({
      recorded,
      ledgerReadable: ledgers.readable,
      satisfied,
      rerunSafe: safety.safe,
    });

    if (decision.action === "skip") {
      continue;
    }
    if (decision.action === "refuse") {
      report(
        describeRefusedMigration(bareId, dbLabel, decision.reason, safety.hazards),
        "error",
      );
      continue;
    }
    if (decision.reason === "reapply_additive") {
      report(
        `[TursoReplica] Migration ${bareId} is recorded as applied but missing on ` +
          `the replica handle — re-applying (additive, so re-running is safe)`,
        "warn",
      );
    }

    const result = await paprDbApplyMigration({
      dbId: record.dbId,
      migrationId: fileName,
    });
    if (result.applied) {
      appliedNow.push(fileName);
      ledgers.ids.add(fileName);
      ledgers.ids.add(bareId);
    }
  }

  return appliedNow;
}
