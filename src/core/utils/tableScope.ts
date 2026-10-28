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
      out.push({ db: s.alias, name: t.table, scope });
    }
  }
  return out;
}

/** Visible across people: no owner column, or per-browser without sign-in. */
export function tableIsShared(t: ScopedTable, signIn: boolean): boolean {
  return t.scope === "all" || (t.scope === "visitor" && !signIn);
}

export function scopeTag(t: ScopedTable, signIn: boolean): string {
  if (t.scope === "private") return "Private";
  if (!tableIsShared(t, signIn)) return "Per person";
  return t.scope === "visitor" ? "Needs sign-in" : "Everyone";
}

export function dataCheckAgentPrompt(appId: string, shared: ScopedTable[]): string {
  const names = shared.map((t) => `${t.db}.${t.name}`).join(", ");
  return (
    `App ${appId} is shared, and these tables are visible to everyone who opens it: ${names}. ` +
    "Make each of them private per person: add a papr_user_id column (require Papr sign-in), " +
    "scope every read and write in the app and its jobs to the signed-in user, and backfill " +
    "existing rows to me. Tell me first if any table is meant to be shared (e.g. a catalog)."
  );
}
