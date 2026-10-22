/**
 * Read-only table/row preview for a registry database linked to a mini-app.
 *
 * Reads go through the DB router (same path as /api/db/query), never straight
 * from the .db file, so replica-backed databases stay consistent and sync is
 * not disturbed. Only sources linked to the requesting app can be previewed.
 */

import type { AppDataSource } from "./appDataSources.js";

export interface LinkedDbPreview {
  dbPath: string;
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; pk: boolean }>;
    rowCount: number;
    rows: Record<string, unknown>[];
  }>;
  selectedTable: string | null;
}

export interface LinkedDbRouter {
  schema(
    dbPath: string,
    source: AppDataSource,
  ): Promise<{
    tables: Array<{
      table: string;
      columns: Array<{ name: string; type: string; pk: boolean }>;
    }>;
  }>;
  query(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

const HIDDEN_TABLES = new Set(["schema_migrations", "sqlite_sequence"]);
const PREVIEW_ROW_LIMIT = 50;

const isHiddenTable = (name: string): boolean =>
  HIDDEN_TABLES.has(name) || name.startsWith("turso_") || name.startsWith("_papr");

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function previewLinkedDatabase(params: {
  appId: string;
  alias: string;
  tableName?: string;
  sources: AppDataSource[];
  router: LinkedDbRouter;
}): Promise<LinkedDbPreview> {
  const source = params.sources.find((entry) => entry.alias === params.alias);
  if (!source) {
    throw new Error(`Data source "${params.alias}" is not linked to this app`);
  }

  const schema = await params.router.schema(source.dbPath, source);
  const userTables = schema.tables.filter((t) => !isHiddenTable(t.table));

  const tables = await Promise.all(
    userTables.map(async (table) => {
      const count = await params.router.query(
        params.appId,
        source,
        `SELECT COUNT(*) AS cnt FROM ${quoteIdent(table.table)}`,
        [],
      );
      const preview = await params.router.query(
        params.appId,
        source,
        `SELECT * FROM ${quoteIdent(table.table)} LIMIT ${PREVIEW_ROW_LIMIT}`,
        [],
      );
      return {
        name: table.table,
        columns: table.columns,
        rowCount: Number(count.rows[0]?.cnt ?? 0),
        rows: preview.rows,
      };
    }),
  );

  const selectedTable =
    params.tableName && tables.some((t) => t.name === params.tableName)
      ? params.tableName
      : tables[0]?.name ?? null;

  return { dbPath: source.dbPath, tables, selectedTable };
}
