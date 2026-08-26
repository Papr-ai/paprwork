/**
 * Helpers for workspace log row replay — table targeting and superseded-op detection.
 */

const INSERT_INTO_TABLE =
  /^\s*INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL)\s+)*INTO\s+(?:[`"[]?(\w+)[`"\]]?\.)?[`"[]?(\w+)[`"\]]?/i;
const UPDATE_TABLE = /^\s*UPDATE\s+(?:[`"[]?(\w+)[`"\]]?\.)?[`"[]?(\w+)[`"\]]?/i;
const DELETE_FROM_TABLE =
  /^\s*DELETE\s+FROM\s+(?:[`"[]?(\w+)[`"\]]?\.)?[`"[]?(\w+)[`"\]]?/i;

/** Primary user table referenced by a replay-safe row SQL statement. */
export function extractPrimaryTableFromRowSql(sql: string): string | null {
  const trimmed = sql.trim();
  for (const pattern of [INSERT_INTO_TABLE, UPDATE_TABLE, DELETE_FROM_TABLE]) {
    const match = pattern.exec(trimmed);
    if (!match) {
      continue;
    }
    const table = match[2] ?? match[1];
    if (table) {
      return table;
    }
  }
  return null;
}

export function isPlatformTableName(tableName: string): boolean {
  return tableName.startsWith("_papr_") || tableName === "schema_migrations";
}
