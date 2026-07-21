/**
 * App data source configuration — primary DB routing, roles, and resolution.
 *
 * data-sources.json supports legacy array format or:
 * { "primary": "audit", "sources": [ ... ] }
 *
 * Backwards compatibility: legacy multi-source arrays without `role: "primary"`
 * do NOT get an implicit primary — table-based routing is preserved until you opt in.
 */

import Database from "better-sqlite3";

export type AppDataSourceRole = "primary" | "readonly" | "scratch";

export interface AppDataSource {
  id: string;
  type: "sqlite";
  /** Legacy job owner — optional when dbId is set. */
  jobId?: string;
  /** Registry database id (first-class resource). */
  dbId?: string;
  alias: string;
  dbPath: string;
  tables: string[];
  linkedAt: string;
  role?: AppDataSourceRole;
}

export interface AppDataSourcesFile {
  /** Alias of the primary SQLite source (mini-app default + APP_DB for jobs). */
  primary?: string;
  sources: AppDataSource[];
}

export const JOB_BASELINE_TABLES = new Set([
  "schema_migrations",
  "job_runs",
  "job_events",
]);

export type TableExistsFn = (dbPath: string, table: string) => Promise<boolean>;

export type DataSourceOperation = "read" | "write";

export function parseDataSourcesFile(raw: string): AppDataSourcesFile {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const sources = parsed as AppDataSource[];
    return {
      primary: inferPrimaryAlias(sources),
      sources,
    };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as AppDataSourcesFile).sources)
  ) {
    const config = parsed as AppDataSourcesFile;
    return {
      primary: config.primary ?? inferPrimaryAlias(config.sources),
      sources: config.sources,
    };
  }
  return { sources: [] };
}

export function serializeDataSourcesFile(config: AppDataSourcesFile): string {
  const primary = config.primary ?? inferPrimaryAlias(config.sources);
  return JSON.stringify(
    {
      ...(primary ? { primary } : {}),
      sources: config.sources,
    },
    null,
    2,
  );
}

export function inferPrimaryAlias(sources: AppDataSource[]): string | undefined {
  const marked = sources.find((s) => s.role === "primary");
  if (marked) return marked.alias;
  // Single source: implicit primary. Multi-source legacy apps keep table-based routing.
  if (sources.length === 1) return sources[0]?.alias;
  return undefined;
}

export function getPrimarySource(
  config: AppDataSourcesFile,
): AppDataSource | undefined {
  const alias = config.primary ?? inferPrimaryAlias(config.sources);
  if (!alias) return undefined;
  return config.sources.find((s) => s.alias === alias || s.id === alias);
}

export function findDataSource(
  config: AppDataSourcesFile,
  sourceId: string,
): AppDataSource | undefined {
  return config.sources.find(
    (s) => s.id === sourceId || s.alias === sourceId,
  );
}

/** Extract the primary table name from SQL for secondary-source routing on reads. */
export function extractPrimaryTable(sql: string): string | null {
  const s = sql.trim();
  let m: RegExpMatchArray | null;
  m = s.match(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bREPLACE\s+INTO\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bUPDATE\s+(?:OR\s+\w+\s+)?["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bDELETE\s+FROM\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bFROM\s+["'`]?(\w+)/i);
  if (m) return m[1];
  return null;
}

export function assertWritableSource(
  source: AppDataSource,
  operation: DataSourceOperation,
): void {
  if (operation === "write" && source.role === "readonly") {
    throw Object.assign(
      new Error(
        `Data source "${source.alias}" is read-only. Writes must target the primary source (${source.role}).`,
      ),
      { status: 403 },
    );
  }
}

/**
 * Resolve which linked data source to use.
 *
 * Priority:
 * 1. Explicit sourceId
 * 2. Primary source (default for reads and writes when configured)
 * 3. Single source
 * 4. Table-based routing across non-primary sources (reads only)
 */
export async function resolveAppDataSource(
  config: AppDataSourcesFile,
  options: {
    sourceId?: string;
    sql?: string;
    operation?: DataSourceOperation;
    tableExists?: TableExistsFn;
  },
): Promise<AppDataSource> {
  const { sourceId, sql, operation = "read", tableExists } = options;
  const { sources } = config;

  if (sourceId) {
    const found = findDataSource(config, sourceId);
    if (!found) {
      const available = sources.map((s) => s.alias ?? s.id).join(", ");
      throw Object.assign(
        new Error(
          `Data source "${sourceId}" not found. Available: ${available}`,
        ),
        { status: 404 },
      );
    }
    assertWritableSource(found, operation);
    return found;
  }

  const primary = getPrimarySource(config);
  if (primary) {
    assertWritableSource(primary, operation);

    if (
      operation === "read" &&
      sql &&
      tableExists &&
      sources.length > 1
    ) {
      const tableName = extractPrimaryTable(sql);
      if (tableName) {
        try {
          const onPrimary = await tableExists(primary.dbPath, tableName);
          if (!onPrimary) {
            for (const source of sources) {
              if (source.alias === primary.alias) continue;
              try {
                if (await tableExists(source.dbPath, tableName)) {
                  return source;
                }
              } catch {
                // unreadable — skip
              }
            }
          }
        } catch {
          // primary unreadable — fall through
        }
      }
    }

    return primary;
  }

  if (sources.length === 1) {
    assertWritableSource(sources[0], operation);
    return sources[0];
  }

  const tableName = sql ? extractPrimaryTable(sql) : null;
  if (tableName && tableExists) {
    for (const source of sources) {
      try {
        if (await tableExists(source.dbPath, tableName)) {
          assertWritableSource(source, operation);
          return source;
        }
      } catch {
        // unreadable — skip
      }
    }
  }

  const aliases = sources.map((s) => `"${s.alias ?? s.id}"`).join(", ");
  const tableHint = tableName
    ? ` Table "${tableName}" was not found in any linked source.`
    : "";
  throw Object.assign(
    new Error(
      `Multiple data sources are linked (${aliases}) and no primary source is configured.${tableHint} Pass sourceId or set "primary" in data-sources.json.`,
    ),
    { status: 400 },
  );
}

/** True when the DB is missing, empty, or only has job infrastructure tables. */
export function dbHasOnlyBaselineTables(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    db.close();
    if (tables.length === 0) return true;
    return tables.every((t) => JOB_BASELINE_TABLES.has(t.name));
  } catch {
    return true;
  }
}

export function buildAppDbTsContent(appId: string, primaryAlias: string): string {
  return `const APP_ID = '${appId}';
/** Primary SQLite source — all app queries route here by default. */
const PRIMARY_SOURCE = '${primaryAlias}';

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, sourceId: PRIMARY_SOURCE, sql, params }),
  });
  const json = (await res.json()) as { rows?: T[]; error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? \`DB query failed (\${res.status})\`);
  }
  return json.rows ?? [];
}

export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  const res = await fetch('/api/db/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, sourceId: PRIMARY_SOURCE, sql, params }),
  });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? \`DB write failed (\${res.status})\`);
  }
}
`;
}
