/**
 * Tables owned by the Turso sync engine, our sync infra, and SQLite itself — and a guard
 * that keeps app-authored SQL away from them.
 *
 * The sync engine keeps private bookkeeping in the same file as app data
 * (`turso_cdc`, `turso_sync_last_change_id`) and reads it back through native Rust. A
 * degraded shape there is not a catchable error: `init_cdc_version` seeks the table's
 * unique index via the `NoConflict` opcode, and on a table with no index the B-tree seek
 * `panic!`s, which aborts the whole process.
 *
 * That is why the statement-kind guards in `sqlValidation.ts` are not sufficient alone.
 * `CREATE TABLE IF NOT EXISTS turso_sync_last_change_id (client_id TEXT, pull_gen TEXT,
 * change_id TEXT)` is a perfectly well-formed CREATE that the kind guard admits, and it
 * plants exactly that panic — an index-free table the engine will later seek an index on.
 *
 * Reads are deliberately not guarded. Reading these tables cannot wedge the engine, and
 * schema introspection legitimately selects from `sqlite_master`.
 *
 * Dependency-free on purpose: shared by the desktop gateway and the cloud app host.
 */

/**
 * Prefixes no app may write to or create.
 *
 * Scoped narrowly rather than reserving all of `turso_`: these are the names the engine
 * and our own sync path actually own (see `legacyCdcArtifacts.ts`), so an app table is
 * very unlikely to collide. The leading underscore on `_papr_` makes accidental
 * collision unlikelier still, and SQLite already refuses user tables named `sqlite_*`.
 */
const RESERVED_TABLE_PREFIXES = [
  "sqlite_",
  "turso_cdc",
  "turso_sync_",
  "_papr_",
] as const;

/** Strip one layer of SQL identifier quoting: "x", `x`, [x], 'x'. */
function unquoteIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "`" && last === "`") ||
    (first === "'" && last === "'") ||
    (first === "[" && last === "]")
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** True when `name` names a table the engine, our sync path, or SQLite owns. */
export function isEngineOwnedTableName(name: string): boolean {
  const bare = unquoteIdentifier(name).toLowerCase();
  return RESERVED_TABLE_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

/**
 * Remove comments and string literals so a reserved name appearing inside app *data*
 * (`INSERT INTO notes(body) VALUES ('see turso_cdc')`) is not mistaken for a reference.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // Single quotes delimit string literals in SQLite; '' is an escaped quote.
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every identifier-shaped token in `sql`, with quoting removed.
 *
 * Scans the whole statement rather than trying to find "the target table". We cannot
 * parse SQL here, and a scan is both simpler and much harder to slip past — a reserved
 * name reachable through a subquery, a CTE, or an `UPDATE ... FROM` is caught the same
 * way the obvious case is.
 */
function referencedIdentifiers(sql: string): string[] {
  const scrubbed = stripLiteralsAndComments(sql);
  const matches = scrubbed.match(/"[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*/g);
  return matches ? matches.map(unquoteIdentifier) : [];
}

/**
 * The first engine-owned table `sql` refers to, or null when it refers to none.
 * Exposed for tests and for callers that want to log which name tripped the guard.
 */
export function findEngineOwnedTableReference(sql: string): string | null {
  for (const identifier of referencedIdentifiers(sql)) {
    if (isEngineOwnedTableName(identifier)) {
      return identifier;
    }
  }
  return null;
}

/**
 * Reject app SQL that touches engine-owned tables.
 *
 * Throws a 403-tagged error shaped like the other guards in `sqlValidation.ts`, so the
 * existing route error handling reports it without changes.
 */
export function assertNoEngineOwnedTableWrite(sql: string): void {
  const table = findEngineOwnedTableReference(sql);
  if (!table) {
    return;
  }
  throw Object.assign(
    new Error(
      `Table "${table}" is managed by the sync engine and cannot be written or created ` +
        "by an app. Use your own table name.",
    ),
    { status: 403 },
  );
}
