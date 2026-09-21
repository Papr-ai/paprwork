/**
 * Scoped Share Links — per-recipient data scoping for mini-apps.
 *
 * One app, one shared database, N named recipients, each with their own URL
 * and their own view of the data. Built for the Papr Data Room: an advisor
 * sees everything, a VC sees four sections and a different raise number, a
 * connector sees intro pathways and nothing else.
 *
 * WHY THIS SHAPE
 *
 * The obvious implementation is "run the app's query, then remove what the
 * recipient may not see". That is what the Data Room did, and it failed: a
 * string-matching filter stopped matching when an unrelated key was inserted
 * into the payload, returned the page unchanged, and shipped 3,098 partner
 * records to every VC link. Silently. Subtraction-after-the-fact fails open.
 *
 * The second-most-obvious implementation is "parse the recipient's SQL and
 * inject a WHERE clause". That moves the failure into a SQL parser, where a
 * single unhandled construct — a correlated subquery, a UNION, a CTE that
 * shadows a table name — becomes a silent bypass. A parser gap is a security
 * hole with extra steps.
 *
 * So scoped recipients do not send SQL at all. They send a *description* of
 * the read they want ({ table, columns, where }) and the server constructs
 * the statement from its own policy. Table and column names are validated
 * against an allowlist and re-emitted as quoted identifiers; the row
 * predicate is the policy's, not the caller's; the caller's filter values
 * only ever arrive as bound parameters. You cannot leak rows you never
 * selected, and there is no grammar to outsmart.
 *
 * Owners and unscoped apps keep raw SQL and are not affected by any of this.
 */

/** Identifiers we are willing to emit into SQL. Deliberately narrow. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Upper bound on rows a scoped read may return, regardless of policy. */
export const SCOPED_MAX_ROWS = 5000;

export type ScopedOrderDirection = "asc" | "desc";

/**
 * What one scope may read from one table.
 *
 * `columns` is an allowlist — `["*"]` is intentionally NOT supported, because
 * "everything" silently grows when someone adds a column. New columns are
 * invisible to recipients until a human lists them.
 */
export interface ScopedTablePolicy {
  columns: string[];
  /**
   * Row predicate, in terms of this table's real columns. Uses `?`
   * placeholders bound by `whereParams`. AND-ed into every read; the caller
   * cannot see, disable, or widen it.
   */
  where?: string;
  whereParams?: unknown[];
  /** Per-table row cap. Clamped by SCOPED_MAX_ROWS. */
  maxRows?: number;
}

/** A named bundle of table policies, e.g. "overview" or "intros". */
export interface ScopePolicy {
  tables: Record<string, ScopedTablePolicy>;
}

/** The full policy for an app: scope name -> what that scope may read. */
export interface SharePolicy {
  scopes: Record<string, ScopePolicy>;
}

/**
 * A recipient of a scoped link — one person, one slug, one URL.
 *
 * Passcode-based by design: a VC should not need a Papr account to open a
 * data room. Identity here is "holder of this link and passcode", which is
 * the same trust model as an unlisted URL, with a second factor.
 */
export interface ShareRecipient {
  appId: string;
  /** URL segment: dataroom.papr.ai/{slug} */
  slug: string;
  label: string;
  /** Plain passcode for v1 parity with existing rooms. Empty = no passcode. */
  passcode?: string;
  /** Scope names from SharePolicy. `["*"]` = full access (founder proxy). */
  scopes: string[];
  /**
   * Per-recipient overrides surfaced to the app (e.g. a different raise
   * number for one fund). Presentation only — never consulted for access.
   */
  vars?: Record<string, unknown>;
  revokedAt?: string | null;
}

/** A resolved recipient, ready to authorize reads. */
export interface ScopeContext {
  appId: string;
  recipientSlug: string;
  /** True when this recipient bypasses scoping entirely. */
  fullAccess: boolean;
  /** Merged table policies across the recipient's scopes. */
  tables: Record<string, ScopedTablePolicy>;
  vars: Record<string, unknown>;
}

/** A structured read request from a scoped caller. */
export interface ScopedQueryRequest {
  table: string;
  /** Omit to receive every column the policy allows. */
  columns?: string[];
  /** Caller-supplied filters, AND-ed on top of the policy predicate. */
  filters?: ScopedFilter[];
  orderBy?: string;
  orderDirection?: ScopedOrderDirection;
  limit?: number;
  offset?: number;
}

/**
 * A caller filter. The operator is chosen from a fixed set and the value is
 * always bound — so a filter can narrow a result set but can never change the
 * shape of the statement.
 */
export interface ScopedFilter {
  column: string;
  op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "in" | "is_null" | "is_not_null";
  value?: unknown;
}

export class ScopeViolationError extends Error {
  readonly status = 403;
  readonly code = "scope_violation";
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

function assertIdentifier(name: string, kind: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new ScopeViolationError(`Invalid ${kind} name`);
  }
  return name;
}

/** Quote an identifier we have already validated. Belt and braces. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Merge the recipient's scopes into one effective policy.
 *
 * Union semantics: two scopes granting the same table produce the union of
 * their columns. Row predicates from different scopes are OR-ed, because each
 * scope independently entitles the recipient to those rows — AND-ing them
 * would let an extra grant *reduce* access, which is the wrong direction and
 * surprising to whoever configured it.
 */
export function resolveScopeContext(
  recipient: ShareRecipient,
  policy: SharePolicy,
): ScopeContext {
  if (recipient.revokedAt) {
    throw new ScopeViolationError("This link has been revoked");
  }

  const base: ScopeContext = {
    appId: recipient.appId,
    recipientSlug: recipient.slug,
    fullAccess: recipient.scopes.includes("*"),
    tables: {},
    vars: recipient.vars ?? {},
  };
  if (base.fullAccess) return base;

  for (const scopeName of recipient.scopes) {
    const scope = policy.scopes[scopeName];
    // An unknown scope name grants nothing. A typo must not silently widen
    // access, and must not crash a room that is otherwise well configured.
    if (!scope) continue;

    for (const [table, tablePolicy] of Object.entries(scope.tables)) {
      const existing = base.tables[table];
      if (!existing) {
        base.tables[table] = {
          columns: [...tablePolicy.columns],
          where: tablePolicy.where,
          whereParams: tablePolicy.whereParams
            ? [...tablePolicy.whereParams]
            : undefined,
          maxRows: tablePolicy.maxRows,
        };
        continue;
      }

      existing.columns = Array.from(
        new Set([...existing.columns, ...tablePolicy.columns]),
      );

      if (!existing.where || !tablePolicy.where) {
        // One of the grants is unconditional, so the union is unconditional.
        existing.where = undefined;
        existing.whereParams = undefined;
      } else {
        existing.where = `(${existing.where}) OR (${tablePolicy.where})`;
        existing.whereParams = [
          ...(existing.whereParams ?? []),
          ...(tablePolicy.whereParams ?? []),
        ];
      }

      if (tablePolicy.maxRows != null) {
        existing.maxRows = Math.max(existing.maxRows ?? 0, tablePolicy.maxRows);
      }
    }
  }

  return base;
}

export interface BuiltScopedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the SQL for a scoped read.
 *
 * Every identifier is allowlist-checked then quoted; every value is bound.
 * The policy predicate is AND-ed at the outermost level so no caller filter
 * can escape it.
 */
export function buildScopedQuery(
  request: ScopedQueryRequest,
  scope: ScopeContext,
): BuiltScopedQuery {
  if (scope.fullAccess) {
    throw new Error("buildScopedQuery called for a full-access context");
  }

  const table = assertIdentifier(request.table, "table");
  const tablePolicy = scope.tables[table];
  if (!tablePolicy) {
    // Deliberately uniform with "column not allowed": the error should not
    // reveal whether a table exists for someone who may not read it.
    throw new ScopeViolationError(`Not permitted: ${table}`);
  }

  const allowedColumns = new Set(tablePolicy.columns);
  const requested =
    request.columns && request.columns.length > 0
      ? request.columns
      : tablePolicy.columns;

  if (requested.length === 0) {
    throw new ScopeViolationError(`Not permitted: ${table}`);
  }

  const projected = requested.map((col) => {
    const name = assertIdentifier(col, "column");
    if (!allowedColumns.has(name)) {
      throw new ScopeViolationError(`Not permitted: ${table}.${name}`);
    }
    return quoteIdent(name);
  });

  const where: string[] = [];
  const params: unknown[] = [];

  // Policy predicate first, so it is present even if later steps throw.
  if (tablePolicy.where) {
    where.push(`(${tablePolicy.where})`);
    params.push(...(tablePolicy.whereParams ?? []));
  }

  for (const filter of request.filters ?? []) {
    const column = assertIdentifier(filter.column, "column");
    // Filtering on a hidden column is a blind oracle: a caller could binary
    // search a value they are not allowed to read. Restrict filters to the
    // columns they may already see.
    if (!allowedColumns.has(column)) {
      throw new ScopeViolationError(`Not permitted: ${table}.${column}`);
    }
    const ref = quoteIdent(column);

    switch (filter.op) {
      case "is_null":
        where.push(`${ref} IS NULL`);
        break;
      case "is_not_null":
        where.push(`${ref} IS NOT NULL`);
        break;
      case "in": {
        const values = Array.isArray(filter.value) ? filter.value : [];
        if (values.length === 0) {
          // An empty IN () is a syntax error in SQLite, and "match nothing"
          // is the honest reading of "in this empty set".
          where.push("0 = 1");
          break;
        }
        if (values.length > 500) {
          throw new ScopeViolationError("Too many values in IN filter");
        }
        where.push(`${ref} IN (${values.map(() => "?").join(", ")})`);
        params.push(...values);
        break;
      }
      case "like":
        where.push(`${ref} LIKE ?`);
        params.push(filter.value);
        break;
      default:
        where.push(`${ref} ${filter.op} ?`);
        params.push(filter.value);
        break;
    }
  }

  let sql = `SELECT ${projected.join(", ")} FROM ${quoteIdent(table)}`;
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;

  if (request.orderBy) {
    const orderCol = assertIdentifier(request.orderBy, "column");
    if (!allowedColumns.has(orderCol)) {
      // Ordering by a hidden column leaks its ordering, which for something
      // like a score or an amount is most of the information.
      throw new ScopeViolationError(`Not permitted: ${table}.${orderCol}`);
    }
    const dir = request.orderDirection === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY ${quoteIdent(orderCol)} ${dir}`;
  }

  const cap = Math.min(tablePolicy.maxRows ?? SCOPED_MAX_ROWS, SCOPED_MAX_ROWS);
  const limit =
    request.limit != null && request.limit > 0
      ? Math.min(Math.floor(request.limit), cap)
      : cap;
  sql += ` LIMIT ${limit}`;

  if (request.offset != null && request.offset > 0) {
    sql += ` OFFSET ${Math.floor(request.offset)}`;
  }

  return { sql, params };
}

/**
 * Whether a scoped recipient may read a file, by the tag recorded on it.
 *
 * Mirrors table scoping for App Files. Without this, a scoped link that
 * cannot query `documents` can still fetch the bytes if it learns an id —
 * which is precisely how the Data Room's /doc/{id} endpoint leaked.
 */
export function isFileReadableInScope(
  fileScopeTag: string | null | undefined,
  scope: ScopeContext,
  policy: SharePolicy,
  recipientScopes: string[],
): boolean {
  if (scope.fullAccess) return true;
  const tag = (fileScopeTag ?? "").trim();
  // Untagged files are readable by nobody scoped: new files default to
  // private rather than public.
  if (!tag) return false;
  for (const scopeName of recipientScopes) {
    if (scopeName === tag && policy.scopes[scopeName]) return true;
  }
  return false;
}

/** Normalize a slug for URL routing. */
export function normalizeRecipientSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Constant-time-ish passcode comparison. */
export function passcodeMatches(
  expected: string | undefined,
  provided: string | undefined,
): boolean {
  if (!expected) return true;
  if (!provided) return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
