/** Shared helpers for idempotent ADD COLUMN during local + remote migrations. */

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

export function parseCreateIndexStatement(
  statement: string,
): { indexName: string } | null {
  const match =
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
      statement.trim(),
    );
  if (!match) {
    return null;
  }
  const indexName = match[1] ?? match[2] ?? match[3];
  if (!indexName) {
    return null;
  }
  return { indexName };
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

/** Strip leading `--` line comments so chunks like `-- header\\nCREATE TABLE…` are kept. */
export function stripLeadingLineComments(sqlChunk: string): string {
  return sqlChunk
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => stripLeadingLineComments(part))
    .filter((part) => part.length > 0);
}
