/**
 * Read registry / app-linked database schema through the correct backend.
 *
 * Plan A replica files must not be opened with better-sqlite3 for validation —
 * the sync engine holds the WAL and concurrent readers get SQLITE_BUSY.
 * Route those reads through TursoReplicaService (same path as DbRouter).
 */

import { existsSync } from "fs";
import Database from "better-sqlite3";
import type { AppDataSource } from "../appDataSources.js";
import type { DatabaseSyncMode } from "../tursoReplica/tursoReplicaTypes.js";
import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";
import { isTursoReplicaSyncFeatureEnabled } from "../../utils/tursoReplicaEnabled.js";

export interface RegistryDbSchemaReadInput {
  dbPath: string;
  dbId?: string;
  alias?: string;
  syncMode?: DatabaseSyncMode;
}

export type RegistryDbSchemaReadErrorCode =
  | "missing"
  | "locked"
  | "unopenable"
  | "unreadable";

export interface RegistryDbSchemaSnapshot {
  tables: Set<string>;
  columnsByTable: Map<string, Set<string>>;
}

export type RegistryDbSchemaReadResult =
  | { ok: true; schema: RegistryDbSchemaSnapshot }
  | { ok: false; code: RegistryDbSchemaReadErrorCode; message: string };

function isSqliteBusyError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return (
    err.code === "SQLITE_BUSY" ||
    /database is locked/i.test(err.message ?? "")
  );
}

function isSqliteNotDbError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return (
    err.code === "SQLITE_NOTADB" ||
    /file is not a database|database disk image is malformed|malformed database schema/i.test(
      err.message ?? "",
    )
  );
}

export function shouldReadRegistrySchemaViaReplica(
  input: RegistryDbSchemaReadInput,
): boolean {
  if (input.syncMode === "replica" && isTursoReplicaSyncFeatureEnabled()) {
    return true;
  }
  return isReplicaManagedDbPath(input.dbPath);
}

function toAppDataSource(input: RegistryDbSchemaReadInput): AppDataSource {
  const alias = input.alias?.trim() || input.dbId?.trim() || "db";
  return {
    id: input.dbId?.trim() || alias,
    type: "sqlite",
    alias,
    dbPath: input.dbPath,
    ...(input.dbId ? { dbId: input.dbId } : {}),
    tables: [],
    linkedAt: new Date(0).toISOString(),
  };
}

function readLocalRegistrySchema(dbPath: string): RegistryDbSchemaReadResult {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return {
        ok: false,
        code: "locked",
        message: (error as Error).message,
      };
    }
    return {
      ok: false,
      code: "unopenable",
      message: (error as Error).message,
    };
  }

  try {
    let tableRows: Array<{ name: string }>;
    try {
      tableRows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
        )
        .all() as Array<{ name: string }>;
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return {
          ok: false,
          code: "locked",
          message: (error as Error).message,
        };
      }
      return {
        ok: false,
        code: "unreadable",
        message: (error as Error).message,
      };
    }

    const tables = new Set(tableRows.map((row) => row.name.toLowerCase()));
    const columnsByTable = new Map<string, Set<string>>();

    for (const table of tables) {
      const columnRows = db
        .prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
        .all() as Array<{ name: string }>;
      columnsByTable.set(
        table,
        new Set(columnRows.map((row) => row.name.toLowerCase())),
      );
    }

    return {
      ok: true,
      schema: { tables, columnsByTable },
    };
  } finally {
    db.close();
  }
}

async function readReplicaRegistrySchema(
  input: RegistryDbSchemaReadInput,
): Promise<RegistryDbSchemaReadResult> {
  try {
    const { schemaLinkedDbViaTursoReplica } = await import(
      "../tursoReplica/tursoReplicaRouting.js"
    );
    const source = toAppDataSource(input);
    const schema = await schemaLinkedDbViaTursoReplica(source);

    const tables = new Set<string>();
    const columnsByTable = new Map<string, Set<string>>();

    for (const table of schema.tables) {
      const normalized = table.table.toLowerCase();
      tables.add(normalized);
      columnsByTable.set(
        normalized,
        new Set(table.columns.map((column) => column.name.toLowerCase())),
      );
    }

    return {
      ok: true,
      schema: { tables, columnsByTable },
    };
  } catch (error) {
    const message = (error as Error).message;
    if (isSqliteBusyError(error)) {
      return { ok: false, code: "locked", message };
    }
    if (isSqliteNotDbError(error)) {
      return { ok: false, code: "unreadable", message };
    }
    return { ok: false, code: "unopenable", message };
  }
}

export async function readRegistryDatabaseSchema(
  input: RegistryDbSchemaReadInput,
): Promise<RegistryDbSchemaReadResult> {
  if (!existsSync(input.dbPath)) {
    return {
      ok: false,
      code: "missing",
      message: `Database not found at ${input.dbPath}`,
    };
  }

  if (shouldReadRegistrySchemaViaReplica(input)) {
    return readReplicaRegistrySchema(input);
  }

  return readLocalRegistrySchema(input.dbPath);
}

/** Row counts for health dashboards — replica-aware. */
export async function countRowsInRegistryTable(
  input: RegistryDbSchemaReadInput,
  table: string,
): Promise<number | null> {
  const escaped = table.replace(/"/g, '""');
  const sql = `SELECT COUNT(*) AS c FROM "${escaped}"`;

  if (shouldReadRegistrySchemaViaReplica(input)) {
    try {
      const { queryLinkedDbViaTursoReplica } = await import(
        "../tursoReplica/tursoReplicaRouting.js"
      );
      const result = await queryLinkedDbViaTursoReplica(
        toAppDataSource(input),
        sql,
        [],
        { pullBeforeRead: false },
      );
      const row = result.rows[0];
      if (!row) return null;
      const value = row.c ?? row[0];
      return typeof value === "number" ? value : Number(value);
    } catch {
      return null;
    }
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(input.dbPath, { readonly: true });
    const row = db.prepare(sql).get() as { c: number } | undefined;
    return row?.c ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function listRegistryUserTables(
  input: RegistryDbSchemaReadInput,
): Promise<string[]> {
  const read = await readRegistryDatabaseSchema(input);
  if (!read.ok) {
    return [];
  }
  return [...read.schema.tables].filter(
    (name) => !name.startsWith("sqlite_"),
  );
}

export async function queryRegistryDatabase(
  input: RegistryDbSchemaReadInput,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] } | null> {
  if (!existsSync(input.dbPath)) {
    return null;
  }

  if (shouldReadRegistrySchemaViaReplica(input)) {
    try {
      const { queryLinkedDbViaTursoReplica } = await import(
        "../tursoReplica/tursoReplicaRouting.js"
      );
      const result = await queryLinkedDbViaTursoReplica(
        toAppDataSource(input),
        sql,
        params,
        { pullBeforeRead: false },
      );
      return { rows: result.rows };
    } catch {
      return null;
    }
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(input.dbPath, { readonly: true });
    const stmt = db.prepare(sql);
    const rows = (
      params.length > 0 ? stmt.all(...params) : stmt.all()
    ) as Record<string, unknown>[];
    return { rows };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
