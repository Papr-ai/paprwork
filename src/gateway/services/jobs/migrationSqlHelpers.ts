/** Shared helpers for idempotent ADD COLUMN during local + remote migrations. */

/**
 * Unquoted SQLite identifier followed by whitespace, `(`, or end of statement.
 *
 * Do NOT use `\S+` here: `CREATE TABLE foo(id INTEGER)` is valid SQLite, and a
 * greedy match captures `foo(` as the table name. The resulting lookup never
 * matches sqlite_master, so the migration is reported unsatisfied forever.
 */
const BARE_IDENT = String.raw`([A-Za-z_][A-Za-z0-9_$]*)`;

/** Quoted (`"x"`, `'x'`, `[x]`, backtick) or bare identifier, optionally schema-qualified. */
const IDENT = String.raw`(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\]|\`([^\`]+)\`|${BARE_IDENT})`;

/** First non-undefined capture group, i.e. whichever quoting style matched. */
function firstCapture(match: RegExpExecArray, start: number, count: number) {
  for (let i = start; i < start + count; i += 1) {
    const value = match[i];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:/i.test(message);
}

export function isMissingColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column:/i.test(message);
}

export function isForeignKeyConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

export function parseCreateTableStatement(
  statement: string,
): { table: string } | null {
  const match = new RegExp(
    String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const table = firstCapture(match, 1, 5);
  return table ? { table } : null;
}

export function parseCreateIndexStatement(
  statement: string,
): { indexName: string } | null {
  const match = new RegExp(
    String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const indexName = firstCapture(match, 1, 5);
  return indexName ? { indexName } : null;
}

/** DROP TABLE/INDEX — "satisfied" means the object is absent (mirrors drop_column). */
export function parseDropStatement(
  statement: string,
): { objectType: "table" | "index"; name: string } | null {
  const match = new RegExp(
    String.raw`^DROP\s+(TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const name = firstCapture(match, 2, 5);
  if (!name) {
    return null;
  }
  return {
    objectType: match[1].toLowerCase() as "table" | "index",
    name,
  };
}

export function parseAddColumnStatement(
  statement: string,
): { table: string; column: string } | null {
  const match = new RegExp(
    String.raw`^ALTER\s+TABLE\s+${IDENT}\s+ADD\s+(?:COLUMN\s+)?${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const table = firstCapture(match, 1, 5);
  const column = firstCapture(match, 6, 5);
  if (!table || !column) {
    return null;
  }
  return { table, column };
}

/**
 * ALTER TABLE x RENAME TO y — the statement that makes copy-and-swap rebuilds
 * unverifiable by name lookup.
 *
 * A rebuild creates a scratch table, copies rows in, then renames it over the
 * original. Verifying the CREATE afterwards looks for a table that no longer
 * exists under that name, so the migration is reported broken even though the
 * schema is exactly right. Parsing RENAME lets the verifier follow the table
 * to its final name instead.
 */
export function parseRenameTableStatement(
  statement: string,
): { from: string; to: string } | null {
  const match = new RegExp(
    String.raw`^ALTER\s+TABLE\s+${IDENT}\s+RENAME\s+TO\s+${IDENT}`,
    "i",
  ).exec(statement.trim());
  if (!match) {
    return null;
  }
  const from = firstCapture(match, 1, 5);
  const to = firstCapture(match, 6, 5);
  if (!from || !to) {
    return null;
  }
  return { from, to };
}

/** Strip leading `--` line comments so chunks like `-- header\nCREATE TABLE…` are kept. */
export function stripLeadingLineComments(sqlChunk: string): string {
  return sqlChunk
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

/**
 * Split a migration file into statements.
 *
 * Comments and string literals are consumed BEFORE `;` is treated as a
 * separator. Splitting first (`sql.split(";")`) breaks on a semicolon inside a
 * `--` comment or a `'a;b'` literal, emitting fragments that are not valid SQL
 * — which the appliers then execute.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    // Line comment: drop through end of line (keep the newline as whitespace).
    if (char === "-" && next === "-") {
      const lineEnd = sql.indexOf("\n", i);
      if (lineEnd === -1) {
        break;
      }
      current += "\n";
      i = lineEnd;
      continue;
    }

    // Block comment: drop through the closing delimiter.
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        break;
      }
      current += " ";
      i = end + 1;
      continue;
    }

    // String/identifier literal: copy verbatim, including any ';' inside.
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      current += char;
      let j = i + 1;
      while (j < sql.length) {
        current += sql[j];
        if (sql[j] === closing) {
          // '' inside a '…' literal is an escaped quote, not the end.
          if (sql[j + 1] === closing && closing !== "]") {
            current += sql[j + 1];
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  statements.push(current);

  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Can this migration run a SECOND time without losing rows?
 *
 * The Plan A replica runner executes before every job run and applies a
 * migration again whenever it cannot confirm the migration already ran. That is
 * harmless for additive DDL -- CREATE ... IF NOT EXISTS, ADD COLUMN (duplicate
 * columns are tolerated), INSERT OR IGNORE -- and destructive for anything that
 * drops, moves or overwrites rows. A copy-and-swap table rebuild replayed
 * against live data is exactly that: on 2026-09-24 re-runs of one emptied the
 * live tables of a telemetry database, in the replica and in Turso.
 *
 * Deliberately conservative: a false hazard costs a drift warning instead of an
 * automatic repair; a missed one costs the data.
 */
export interface MigrationRerunSafety {
  /** True when every statement is additive or idempotent. */
  safe: boolean;
  /** One entry per statement that would drop, move or overwrite rows. */
  hazards: string[];
}

/** Blank out '…' literals so keyword checks cannot match inside string data. */
function withoutStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function excerpt(sql: string): string {
  return sql.length > 72 ? `${sql.slice(0, 69)}…` : sql;
}

function rerunHazard(statement: string): string | null {
  const sql = statement.replace(/\s+/g, " ").trim();
  if (sql.length === 0) {
    return null;
  }
  const drop = parseDropStatement(sql);
  if (drop) {
    // Dropping an index loses no rows; dropping a table loses all of them.
    return drop.objectType === "table" ? `DROP TABLE ${drop.name}` : null;
  }
  const rename = parseRenameTableStatement(sql);
  if (rename) {
    return `ALTER TABLE ${rename.from} RENAME TO ${rename.to}`;
  }
  if (new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}\s+DROP\s`, "i").test(sql)) {
    return excerpt(sql);
  }
  const bare = withoutStringLiterals(sql);
  const insert = /^INSERT\s+(?:OR\s+([A-Z]+)\s+)?INTO\b/i.exec(bare);
  if (insert) {
    const onConflict = insert[1]?.toUpperCase();
    if (onConflict === "IGNORE") {
      return null;
    }
    // The upsert spelling of OR IGNORE. DO UPDATE overwrites, so it stays a hazard.
    if (
      onConflict === undefined &&
      /\bON\s+CONFLICT\b/i.test(bare) &&
      /\bDO\s+NOTHING\b/i.test(bare) &&
      !/\bDO\s+UPDATE\b/i.test(bare)
    ) {
      return null;
    }
    // Plain INSERT duplicates rows (or aborts the run on a key conflict);
    // OR REPLACE / DO UPDATE overwrite rows written since the first run.
    return excerpt(sql);
  }
  if (/^(?:DELETE|UPDATE|REPLACE)\b/i.test(bare)) {
    return excerpt(sql);
  }
  if (/^WITH\b/i.test(bare) && /\b(?:DELETE|UPDATE|INSERT|REPLACE)\b/i.test(bare)) {
    return excerpt(sql);
  }
  return null;
}

export function migrationRerunSafety(sql: string): MigrationRerunSafety {
  const hazards = splitSqlStatements(sql)
    .map(rerunHazard)
    .filter((hazard): hazard is string => hazard !== null);
  return { safe: hazards.length === 0, hazards };
}
