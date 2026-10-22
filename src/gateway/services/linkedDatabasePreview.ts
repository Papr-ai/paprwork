/**
 * Read-only, paged table/row preview for a registry database linked to a mini-app.
 *
 * Reads go through the DB router (same path as /api/db/query), never straight
 * from the .db file, so replica-backed databases stay consistent and sync is
 * not disturbed. Only sources linked to the requesting app can be previewed.
 * Rows are fetched only for the selected table, one page at a time.
 */

import type { AppDataSource } from "./appDataSources.js";
import { normalizePreviewPaging, previewOrderBy } from "./dbPreviewPaging.js";

export interface LinkedDbPreview {
  dbPath: string;
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; pk: boolean }>;
    rowCount: number;
    rows: Record<string, unknown>[];
  }>;
  selectedTable: string | null;
  limit: number;
  offset: number;
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

const isHiddenTable = (name: string): boolean =>
  HIDDEN_TABLES.has(name) || name.startsWith("turso_") || name.startsWith("_papr");

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function previewLinkedDatabase(params: {
  appId: string;
  alias: string;
  tableName?: string;
  limit?: number;
  offset?: number;
  sources: AppDataSource[];
  router: LinkedDbRouter;
}): Promise<LinkedDbPreview> {
  const source = params.sources.find((entry) => entry.alias === params.alias);
  if (!source) {
    throw new Error(`Data source "${params.alias}" is not linked to this app`);
  }

  const { limit, offset } = normalizePreviewPaging(params.limit, params.offset);
  const schema = await params.router.schema(source.dbPath, source);
  const userTables = schema.tables.filter((t) => !isHiddenTable(t.table));
  const selectedTable =
    params.tableName && userTables.some((t) => t.table === params.tableName)
      ? params.tableName
      : userTables[0]?.table ?? null;

  const tables = await Promise.all(
    userTables.map(async (table) => {
      const count = await params.router.query(
        params.appId,
        source,
        `SELECT COUNT(*) AS cnt FROM ${quoteIdent(table.table)}`,
        [],
      );
      let rows: Record<string, unknown>[] = [];
      if (table.table === selectedTable) {
        const page = await params.router.query(
          params.appId,
          source,
          `SELECT * FROM ${quoteIdent(table.table)}${previewOrderBy(table.columns)} LIMIT ${limit} OFFSET ${offset}`,
          [],
        );
        rows = page.rows;
      }
      return {
        name: table.table,
        columns: table.columns,
        rowCount: Number(count.rows[0]?.cnt ?? 0),
        rows,
      };
    }),
  );

  return { dbPath: source.dbPath, tables, selectedTable, limit, offset };
}
