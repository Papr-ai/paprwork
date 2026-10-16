/**
 * Browser SQL on the cloud host runs with a Turso token that lists only the
 * database's PUBLIC tables (memory mints it with fine-grained permissions).
 * Turso — not a SQL scanner — refuses everything else: private tables, views
 * over them, joins/subqueries/CTEs that touch them, and sync/engine tables.
 * New tables are denied until the list refreshes, so mistakes block, never leak.
 */

/** Never put on a client token, whatever the schema says. */
const ENGINE_PREFIXES = ["sqlite_", "_papr_", "__papr", "turso_", "libsql_", "_litestream"] as const;

export type ClientScopeMode = "read" | "write" | "ddl";

export const CLIENT_SCOPE_SCHEMA_SQL =
  "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'";

export function isEngineTable(name: string): boolean {
  const lower = name.toLowerCase();
  return ENGINE_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Public tables + views for a client token. Drops declared private tables
 * (case-insensitive), the shadow tables of private virtual tables (FTS
 * `notes_content`, …), and engine tables. Sorted for stable cache keys.
 */
export function publicTablesFromSchema(
  rows: ReadonlyArray<Record<string, unknown>>,
  privateTables: ReadonlySet<string>,
): string[] {
  const priv = new Set([...privateTables].map((t) => t.toLowerCase()));
  const privateVirtual = rows
    .filter((r) => priv.has(String(r["name"] ?? "").toLowerCase()) && /^\s*create\s+virtual\s+table/i.test(String(r["sql"] ?? "")))
    .map((r) => `${String(r["name"]).toLowerCase()}_`);
  const out = new Set<string>();
  for (const r of rows) {
    const name = String(r["name"] ?? "");
    const lower = name.toLowerCase();
    if (!name || isEngineTable(name) || priv.has(lower)) continue;
    if (privateVirtual.some((prefix) => lower.startsWith(prefix))) continue;
    out.add(name);
  }
  return [...out].sort();
}

/** True when the JWT carries Turso fine-grained permissions (`perm` claim). */
export function tokenHasTablePermissions(jwt: string): boolean {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { perm?: unknown };
    return Array.isArray(json.perm) && json.perm.length > 0;
  } catch {
    return false;
  }
}

/** Table named in a Turso SQLITE_AUTH error ("access to notes.id is prohibited"), if any. */
export function deniedTableFromError(err: unknown): { denied: boolean; table?: string } {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const text = `${e?.code ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  if (!/SQLITE_AUTH|not authorized|is prohibited/i.test(text)) return { denied: false };
  const m = /access to ([^\s.]+(?:\s[^\s.]+)*)\.[^\s]+ is prohibited/i.exec(text);
  return { denied: true, ...(m ? { table: m[1] } : {}) };
}

function forbidden(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { status: 403, ...extra });
}

/**
 * Turso's bare "not authorized" (count(*), writes) names no table. For the
 * message only, guess it from the SQL: first private or internal table named.
 * Enforcement never depends on this.
 */
export function guessDeniedTable(sql: string, privateTables: ReadonlySet<string>): string | undefined {
  for (const m of sql.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    const lower = m[0].toLowerCase();
    if (privateTables.has(lower) || isEngineTable(lower)) return m[0];
  }
  return undefined;
}

/** Plain-English 403 for a query Turso refused. */
export function clientDeniedError(table: string | undefined, privateTables: ReadonlySet<string>, mode: ClientScopeMode): Error {
  const lower = table?.toLowerCase();
  if (lower && privateTables.has(lower)) {
    return forbidden(
      `Table "${table}" is private — read it through a backend action. ` +
        "The browser can't query private tables directly; a backend action filters rows by the signed-in caller.",
      { code: "table_private", table: lower },
    );
  }
  if (table && isEngineTable(table)) {
    return forbidden(`Table "${table}" is internal and not readable from the app.`, { code: "table_internal", table: lower });
  }
  if (!table) {
    return forbidden(
      mode === "read"
        ? "This query reads a table the app's pages can't use."
        : "This link can't make that change (read-only, or the statement touches a table pages can't use).",
      { code: "table_denied" },
    );
  }
  return forbidden(`Table "${table}" isn't available to this app's pages.`, { code: "table_denied", table: lower });
}
