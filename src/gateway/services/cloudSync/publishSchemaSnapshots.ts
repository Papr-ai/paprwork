/**
 * Publish step: capture the schema of every database this app owns the schema
 * for into data/databases/{slug}/migrations/snapshot.json, which the existing
 * migrations upload carries to the repo. Installers build from it (see
 * jobs/schemaSnapshotApply.ts).
 *
 * Read through the same router the app uses, so replica, cloud-direct and
 * local databases are all read by their own engine (never better-sqlite3 on a
 * replica file).
 *
 * Best effort: a failure keeps the previous snapshot, and installers whose
 * snapshot no longer matches the migration files replay migrations instead.
 */

import path from "path";
import type { AppDataSource } from "../appDataSources.js";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";
import {
  buildSchemaSnapshot,
  writeSchemaSnapshot,
  type SchemaObjectRow,
} from "../jobs/schemaSnapshot.js";

type Query = (source: AppDataSource, sql: string) => Promise<Record<string, unknown>[]>;

const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid";

const LEDGER_TABLES = ["schema_migrations", "_papr_schema_migrations"] as const;

function recordAsSource(record: DatabaseRecord): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    alias: record.label ?? record.dbId,
    dbId: record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

async function readAppliedIds(query: Query, source: AppDataSource): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const table of LEDGER_TABLES) {
    try {
      for (const row of await query(source, `SELECT id FROM "${table}"`)) {
        const id = String(row.id ?? "").trim();
        if (id) {
          ids.add(id);
        }
      }
    } catch {
      /* ledger table absent on this engine */
    }
  }
  return ids;
}

export async function snapshotOneDatabase(
  record: DatabaseRecord,
  query: Query,
): Promise<"written" | "unchanged" | "skipped"> {
  const migrationRoot = path.dirname(record.localPath);
  const source = recordAsSource(record);
  const schemaRows = (await query(source, SCHEMA_SQL)) as unknown as SchemaObjectRow[];
  const appliedLedgerIds = await readAppliedIds(query, source);
  const snapshot = await buildSchemaSnapshot({ migrationRoot, schemaRows, appliedLedgerIds });
  if (!snapshot) {
    // Not describable (gap in applied migrations / nothing applied): remove a
    // stale snapshot rather than ship one that lies.
    await writeSchemaSnapshot(migrationRoot, null);
    return "skipped";
  }
  return (await writeSchemaSnapshot(migrationRoot, snapshot)) ? "written" : "unchanged";
}

export async function writeSchemaSnapshotsForApp(
  paprDir: string,
  appId: string,
): Promise<void> {
  const { initializeDatabaseRegistry } = await import("../DatabaseRegistryService.js");
  const registry = await initializeDatabaseRegistry();
  const owned = registry.listBySchemaOwnerApp(appId);
  if (owned.length === 0) {
    return;
  }
  const { getDbRouter } = await import("../appRuntime/DbRouter.js");
  const router = getDbRouter();
  const query: Query = async (source, sql) =>
    (await router.query(appId, source, sql)).rows;

  for (const record of owned) {
    if (!record.localPath.startsWith(path.join(paprDir, "data"))) {
      continue;
    }
    try {
      const outcome = await snapshotOneDatabase(record, query);
      if (outcome === "written") {
        console.log(`[SchemaSnapshot] Updated snapshot for ${record.label ?? record.dbId}`);
      }
    } catch (error) {
      console.warn(
        `[SchemaSnapshot] Could not snapshot ${record.label ?? record.dbId}: ` +
          (error as Error).message.slice(0, 160),
      );
    }
  }
}
