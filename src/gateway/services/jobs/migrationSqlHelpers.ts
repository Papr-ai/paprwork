/** Shared helpers for idempotent ADD COLUMN during local + remote migrations. */

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

export function parseAddColumnStatement(
  statement: string,
): { table: string; column: string } | null {
  const match =
    /^ALTER\s+TABLE\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+ADD\s+COLUMN\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
      statement.trim(),
    );
  if (!match) {
    return null;
  }
  const table = match[1] ?? match[2] ?? match[3];
  const column = match[4] ?? match[5] ?? match[6];
  if (!table || !column) {
    return null;
  }
  return { table, column };
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("--"));
}
