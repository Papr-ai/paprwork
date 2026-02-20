/**
 * useAppDataSources - Fetch SQLite schema and run queries for app-linked data sources
 *
 * Used by the App Data Views sidebar to show tables and browse data with pagination.
 */

import { useState, useCallback, useEffect } from "react";
import { gateway } from "../src/lib/gateway";

export interface TableColumn {
  name: string;
  type: string;
  pk: boolean;
}

export interface TableInfo {
  table: string;
  columns: TableColumn[];
}

export interface DbSource {
  sourceId: string;
  alias: string;
  dbPath: string;
  tables?: TableInfo[];
  error?: string;
}

export interface SchemaResponse {
  sources: DbSource[];
}

export interface QueryResponse {
  rows: Record<string, unknown>[];
  columns: string[];
  count: number;
  source: string;
}

const PAGE_SIZE = 50;

interface UseAppDataSourcesOptions {
  skipSchema?: boolean;
}

export function useAppDataSources(
  appId: string | null,
  options: UseAppDataSourcesOptions = {},
) {
  const { skipSchema = false } = options;
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSchema = useCallback(async () => {
    if (!appId) {
      setSchema(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("db:schema", { appId });
      const data = response.data as SchemaResponse;
      setSchema(data ?? { sources: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schema");
      setSchema(null);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!skipSchema) loadSchema();
  }, [loadSchema, skipSchema]);

  const queryTable = useCallback(
    async (
      tableName: string,
      page = 1,
      sourceId?: string,
    ): Promise<QueryResponse> => {
      if (!appId) throw new Error("appId required");
      const offset = (page - 1) * PAGE_SIZE;
      const sql = `SELECT * FROM ${escapeTableName(tableName)} LIMIT ? OFFSET ?`;
      const response = await gateway.send("db:query", {
        appId,
        sql,
        params: [PAGE_SIZE, offset],
        sourceId,
      });
      return response.data as QueryResponse;
    },
    [appId],
  );

  const getTotalCount = useCallback(
    async (tableName: string, sourceId?: string): Promise<number> => {
      if (!appId) return 0;
      const sql = `SELECT COUNT(*) as count FROM ${escapeTableName(tableName)}`;
      const response = await gateway.send("db:query", {
        appId,
        sql,
        sourceId,
      });
      const data = response.data as QueryResponse;
      const countRow = data.rows[0];
      if (countRow && typeof countRow.count === "number") {
        return countRow.count;
      }
      if (countRow && typeof countRow.count === "string") {
        return parseInt(countRow.count, 10) || 0;
      }
      return 0;
    },
    [appId],
  );

  return {
    schema,
    loading,
    error,
    reloadSchema: loadSchema,
    queryTable,
    getTotalCount,
    pageSize: PAGE_SIZE,
  };
}

function escapeTableName(name: string): string {
  // SQLite identifiers: use double quotes for safety
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return `"${name}"`;
  }
  return `"${name.replace(/"/g, '""')}"`;
}
