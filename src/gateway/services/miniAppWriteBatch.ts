/**
 * Shared mini-app POST /api/db/write-batch execution (local gateway).
 */

import type { AppDataSource } from "./appDataSources.js";
import type { DbQueryPool } from "./DbQueryPool.js";
import type { DbRouter } from "./appRuntime/DbRouter.js";
import {
  writeLinkedDbBatchAtomic,
  writeLinkedDbRowLocalFirst,
} from "./syncV3/localFirstDbWrite.js";
import { assertReplaySafeRowSql } from "./syncV3/replaySafeSql.js";

export interface MiniAppWriteBatchStatement {
  sourceId?: string;
  sql?: string;
  params?: unknown[];
}

export function isMiniAppWriteSql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return (
    trimmed.startsWith("insert") ||
    trimmed.startsWith("update") ||
    trimmed.startsWith("delete") ||
    trimmed.startsWith("replace") ||
    trimmed.startsWith("upsert")
  );
}

type ResolveLinkedSource = (
  appId: string,
  sourceId: string | undefined,
  sql: string,
  operation: "read" | "write",
) => Promise<AppDataSource>;

export async function executeMiniAppWriteBatch(input: {
  appId: string;
  statements: MiniAppWriteBatchStatement[];
  atomic: boolean;
  pool: DbQueryPool;
  dbRouter: DbRouter;
  resolveLinkedSource: ResolveLinkedSource;
}): Promise<{ atomic: boolean; results: Array<Record<string, unknown>> }> {
  const { appId, statements, atomic, pool, dbRouter, resolveLinkedSource } = input;

  type Resolved = {
    source: AppDataSource;
    sql: string;
    params?: unknown[];
  };

  const resolved: Resolved[] = [];
  for (const stmt of statements) {
    if (!stmt?.sql) {
      throw Object.assign(new Error("Every statement requires sql"), { status: 400 });
    }
    if (!isMiniAppWriteSql(stmt.sql)) {
      throw Object.assign(
        new Error(
          "Only INSERT, UPDATE, DELETE, REPLACE, and UPSERT are allowed on /api/db/write-batch.",
        ),
        { status: 403 },
      );
    }
    assertReplaySafeRowSql(stmt.sql);
    const source = await resolveLinkedSource(appId, stmt.sourceId, stmt.sql, "write");
    resolved.push({ source, sql: stmt.sql, params: stmt.params });
  }

  if (atomic) {
    const dbKeys = new Set(
      resolved.map((item) => item.source.dbPath ?? item.source.jobId ?? item.source.alias),
    );
    if (dbKeys.size > 1) {
      throw Object.assign(
        new Error(
          "atomic write-batch requires all statements on the same linked database (sourceId).",
        ),
        { status: 400 },
      );
    }

    const { source, results: writeResults } = await writeLinkedDbBatchAtomic(
      pool,
      dbRouter,
      appId,
      resolved[0].source,
      resolved.map((item) => ({ sql: item.sql, params: item.params })),
    );

    return {
      atomic: true,
      results: writeResults.map((result) => ({
        ok: true,
        ...result,
        source: source.alias,
      })),
    };
  }

  const results: Array<Record<string, unknown>> = [];
  for (const stmt of statements) {
    if (!stmt?.sql) {
      results.push({ ok: false, error: "Every statement requires sql" });
      continue;
    }
    if (!isMiniAppWriteSql(stmt.sql)) {
      results.push({
        ok: false,
        error:
          "Only INSERT, UPDATE, DELETE, REPLACE, and UPSERT are allowed on /api/db/write-batch.",
      });
      continue;
    }

    try {
      assertReplaySafeRowSql(stmt.sql);
      const source = await resolveLinkedSource(appId, stmt.sourceId, stmt.sql, "write");
      const result = await writeLinkedDbRowLocalFirst(
        pool,
        dbRouter,
        appId,
        source,
        stmt.sql,
        stmt.params,
      );
      results.push({ ok: true, ...result, source: source.alias });
    } catch (stmtErr) {
      const e = stmtErr as Error & { name?: string };
      results.push({ ok: false, error: e.message });
    }
  }

  return { atomic: false, results };
}
