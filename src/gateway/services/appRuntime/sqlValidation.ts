/**
 * SQL statement guards for mini-app /api/db/* routes.
 * Shared by desktop gateway and cloud app host.
 *
 * Statement *kind* is only half of it: a well-formed INSERT or CREATE aimed at the sync
 * engine's private tables aborts the native sync worker. See `engineOwnedTables.ts`.
 */

import { assertNoEngineOwnedTableWrite } from "./engineOwnedTables.js";

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    throw Object.assign(
      new Error("Only SELECT (and WITH ... SELECT) queries are allowed"),
      { status: 403 },
    );
  }
}

export function assertWriteSql(sql: string): void {
  const trimmed = sql.trim().toLowerCase();
  const isWrite =
    trimmed.startsWith("insert") ||
    trimmed.startsWith("update") ||
    trimmed.startsWith("delete") ||
    trimmed.startsWith("replace") ||
    trimmed.startsWith("upsert");

  if (!isWrite) {
    throw Object.assign(
      new Error(
        "Only INSERT, UPDATE, DELETE, REPLACE, and UPSERT are allowed on /api/db/write. Use /api/db/query for SELECT.",
      ),
      { status: 403 },
    );
  }

  assertNoEngineOwnedTableWrite(sql);
}

export function assertExecSql(sql: string): void {
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith("create table if not exists")) {
    throw Object.assign(
      new Error("Only CREATE TABLE IF NOT EXISTS is allowed on /api/db/exec."),
      { status: 403 },
    );
  }

  assertNoEngineOwnedTableWrite(sql);
}
