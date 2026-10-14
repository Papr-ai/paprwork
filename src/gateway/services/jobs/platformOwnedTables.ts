/**
 * Tables Papr owns inside an app's database.
 *
 * The platform creates and upgrades these itself (App Files on first use, the
 * sync engine for `_papr_*` / `turso_*`). An app migration that rebuilds one
 * is copying the platform's DDL at one moment in time, and it breaks fresh
 * installs: the installer's database does not have the platform table yet
 * when the migration replays, so the copy-and-swap fails with
 * "no such table: app_files" and the whole install rolls back.
 *
 * Real case (Scenario, Oct 2026): a "restore table keys" repair migration
 * rebuilt app_files, app_file_hashes, _papr_sync_meta and _papr_sync_mute next
 * to the app's own tables. It applied fine on the publisher (where those
 * tables existed) and failed every Community install.
 *
 * Three uses, one definition:
 *   - authoring: papr_db_create_migration refuses such statements
 *   - replay:    the statement guards skip them (old migrations stay installable)
 *   - snapshot:  the publish-time snapshot builder ignores them
 */

const IDENT = String.raw`(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\]|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_$]*))`;

/** App Files tables and the temp copies a rebuild makes (`app_files__fix`, `app_files_new`). */
const APP_FILES_FAMILY = /^(?:app_files|app_file_hashes)(?:$|__|_(?:new|old|tmp|bak|backup|copy|fix|pk)$)/;

/**
 * Platform-owned table name (case-insensitive).
 *
 * Deliberately excludes `sqlite_*`: `DELETE FROM sqlite_sequence` is a
 * legitimate app migration (resetting AUTOINCREMENT).
 */
export function isPlatformOwnedTable(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("_papr_") ||
    lower.startsWith("turso_") ||
    lower.startsWith("__turso") ||
    lower.startsWith("libsql_") ||
    lower.startsWith("_litestream") ||
    lower === "schema_migrations" ||
    APP_FILES_FAMILY.test(lower)
  );
}

function first(match: RegExpExecArray | null, start: number): string | null {
  if (!match) return null;
  for (let i = start; i < start + 5; i += 1) {
    if (match[i]) return match[i];
  }
  return null;
}

const TARGET_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table  → the table
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+ON\s+${IDENT}`,
      "i",
    ),
    group: 6,
  },
  // CREATE TRIGGER … ON table
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}[\s\S]*?\bON\s+${IDENT}`,
      "i",
    ),
    group: 6,
  },
  {
    re: new RegExp(
      String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
      "i",
    ),
    group: 1,
  },
  { re: new RegExp(String.raw`^(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+${IDENT}`, "i"), group: 1 },
  { re: new RegExp(String.raw`^UPDATE(?:\s+OR\s+\w+)?\s+${IDENT}`, "i"), group: 1 },
  { re: new RegExp(String.raw`^DELETE\s+FROM\s+${IDENT}`, "i"), group: 1 },
  { re: new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, "i"), group: 1 },
  { re: new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}`, "i"), group: 1 },
];

/**
 * The table a statement creates, writes, alters or drops — when that table is
 * platform-owned. Null for everything else (including app statements that
 * merely READ a platform table). Leading `--` comments are ignored.
 */
export function platformOwnedTarget(statement: string): string | null {
  const sql = statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  for (const { re, group } of TARGET_PATTERNS) {
    const table = first(re.exec(sql), group);
    if (table) {
      return isPlatformOwnedTable(table) ? table : null;
    }
  }
  return null;
}

export function platformOwnedSkipReason(table: string): string {
  return `${table} is a Papr platform table; the platform creates and upgrades it, app migrations do not`;
}

/** Statements in `statements` that target platform-owned tables (for authoring errors). */
export function platformOwnedStatements(
  statements: readonly string[],
): Array<{ table: string; statement: string }> {
  const hits: Array<{ table: string; statement: string }> = [];
  for (const statement of statements) {
    const table = platformOwnedTarget(statement);
    if (table) hits.push({ table, statement });
  }
  return hits;
}
