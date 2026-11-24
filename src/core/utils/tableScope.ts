/**
 * v9 data check: which shared tables would visitors see across people?
 *
 * Scope per table, from its columns (the conventions Pen builds apps with):
 *   user    — papr_user_id: each signed-in person sees their own rows
 *   visitor — owner_session: per browser, but only without sign-in it's guessable
 *   all     — no owner column: everyone who can open the app sees every row
 *   private — marked private on the database (papr_db_set_table_access): the
 *             browser can't query it; rows are read through backend actions
 *             that filter on _acl, so who sees what is the app's own sharing
 * A database with per-user isolation is "user" for every table.
 * Engine / sync / migration bookkeeping is not app data and is never listed
 * (browser tokens never include it either; see clientTableScope.ts).
 */

export type TableScope = "all" | "user" | "visitor" | "private";

export interface ScopedTable {
  db: string;
  name: string;
  scope: TableScope;
  /** Up to COLUMN_CAP user-facing column names for the Share sheet hover card. */
  columns?: string[];
  /** How many more columns the table has beyond `columns`. */
  moreColumns?: number;
}

/** Columns kept per table: enough for the hover card, keeps the response small. */
export const COLUMN_CAP = 12;
/** Bookkeeping columns that mean nothing to the person sharing. */
const HIDDEN_COLS = /^(id|_acl|_rowid_|rowid|papr_user_id|owner_session|created_by)$/i;

function shownColumns(columns: Array<{ name: string }>): Pick<ScopedTable, "columns" | "moreColumns"> {
  const names = columns.map((c) => c.name).filter((n) => !HIDDEN_COLS.test(n) && !n.startsWith("_"));
  return { columns: names.slice(0, COLUMN_CAP), moreColumns: Math.max(0, names.length - COLUMN_CAP) };
}

export interface SchemaSourceLike {
  alias: string;
  perUser?: boolean;
  /** Tables marked private on the registry record (lower-case or any case). */
  privateTables?: string[];
  tables: Array<{ table: string; columns: Array<{ name: string }> }>;
}

const INTERNAL = /^(sqlite_|_papr|__papr|_cf_|papr_|_litestream|__|turso_|libsql_|schema_migrations$)/i;
const USER_COLS = new Set(["papr_user_id"]);
const VISITOR_COLS = new Set(["owner_session"]);

export function tableScope(columns: Array<{ name: string }>, perUser = false): TableScope {
  if (perUser) return "user";
  const names = columns.map((c) => c.name.toLowerCase());
  if (names.some((n) => USER_COLS.has(n))) return "user";
  if (names.some((n) => VISITOR_COLS.has(n))) return "visitor";
  return "all";
}

export function scopeTables(sources: SchemaSourceLike[]): ScopedTable[] {
  const out: ScopedTable[] = [];
  for (const s of sources) {
    const priv = new Set((s.privateTables ?? []).map((n) => n.toLowerCase()));
    for (const t of s.tables) {
      if (INTERNAL.test(t.table)) continue;
      const scope = priv.has(t.table.toLowerCase()) ? "private" : tableScope(t.columns, s.perUser);
      out.push({ db: s.alias, name: t.table, scope, ...shownColumns(t.columns) });
    }
  }
  return out;
}

/** Visible across people: no owner column, or per-browser without sign-in. */
export function tableIsShared(t: ScopedTable, signIn: boolean): boolean {
  return t.scope === "all" || (t.scope === "visitor" && !signIn);
}

/** Hover-card line: which rows someone with access sees. */
export function rowsLine(t: ScopedTable, signIn: boolean): string {
  if (tableIsShared(t, signIn)) return "Every row";
  if (t.scope === "private") return "Rows shared with them";
  return "Their own rows";
}

/** Table name as a person reads it: deal_notes -> deal notes. */
export function humanTable(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

export function scopeTag(t: ScopedTable, signIn: boolean): string {
  if (t.scope === "private") return "Private";
  if (!tableIsShared(t, signIn)) return "Per person";
  return t.scope === "visitor" ? "Needs sign-in" : "Everyone";
}

/** "Ask Pen" in the Share sheet: opens a new chat with this already sent, like "Set up with Pen". */
export const DATA_CHECK_CHAT_TITLE = "Review shared data";

export function dataCheckAgentPrompt(appId: string, shared: ScopedTable[]): string {
  const names = shared.map((t) => `${t.db}.${t.name}`);
  const list = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
  const n = names.length;
  return (
    `Help me review what people see when I share app ${appId}. ` +
    `${n} table${n === 1 ? "" : "s"} show every row to everyone with access: ${list}. ` +
    "Ask me which should stay shared (catalogs, settings), then make the rest private per person: " +
    "add _acl and created_by, write new rows with acl_for_caller(), and set existing rows to me. " +
    "Check the app and its jobs still work after."
  );
}
