/**
 * App data source configuration — linked registry DBs by alias.
 *
 * data-sources.json: { "sources": [ { alias, dbPath, dbId, ... } ] }
 * Legacy files may still contain "primary" (alias string) or role: "primary" on a source.
 * Those act only as a fallback when sourceId is omitted — never written on new saves.
 */

import { existsSync, statSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { isReplicaManagedDbPath } from "./tursoReplica/tursoReplicaFileGuard.js";

/** @deprecated Ignored on new links. Parsed only for legacy files. */
export type AppDataSourceRole = "primary" | "readonly" | "scratch";

/** Who may write rows. Absent = bidirectional (web + desktop). */
export type WriteAuthority = "bidirectional" | "desktop";

export function isBidirectionalWriteAuthority(
  writeAuthority?: WriteAuthority,
): boolean {
  return writeAuthority !== "desktop";
}

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
  /** @deprecated No longer enforced — all linked sources are read+write for mini-apps. */
  role?: AppDataSourceRole;
  /** Omit for bidirectional (default) — web forms and desktop sync both write. */
  writeAuthority?: WriteAuthority;
}

export interface AppDataSourcesFile {
  /** @deprecated Legacy alias — read-only fallback when sourceId omitted; not written on new saves. */
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
    return { sources: parsed as AppDataSource[] };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as AppDataSourcesFile).sources)
  ) {
    const config = parsed as AppDataSourcesFile;
    return { sources: config.sources, ...(config.primary ? { primary: config.primary } : {}) };
  }
  return { sources: [] };
}

export function slugifyDatabaseAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Prefer descriptive aliases — never default new links to legacy "primary". */
export function resolveAttachAlias(input: {
  requested?: string;
  registryLabel?: string;
  dbId: string;
}): string {
  const trimmed = input.requested?.trim();
  if (trimmed && trimmed !== "primary") {
    return trimmed;
  }
  if (input.registryLabel?.trim()) {
    return slugifyDatabaseAlias(input.registryLabel);
  }
  return input.dbId;
}

export function serializeDataSourcesFile(config: AppDataSourcesFile): string {
  const sources = config.sources.map(({ role: _role, ...source }) => source);
  return JSON.stringify({ sources }, null, 2);
}

/** Active workspace path for a job-owned SQLite database. */
export function canonicalJobDatabasePath(
  jobsRoot: string,
  jobId: string,
): string {
  return path.join(jobsRoot, jobId, "data", "data.db");
}

export function isPathWithinWorkspace(
  candidatePath: string,
  workspaceRoot: string,
): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

/**
 * Resolve job-linked dbPath from the active workspace Jobs tree.
 * Each namespace owns its own Jobs/ copy — stored paths from other namespaces are ignored
 * when the job database exists locally (no repair or workspace-switch step required).
 */
export function resolveJobLinkedSourceForWorkspace(
  source: AppDataSource,
  jobsRoot: string,
): AppDataSource {
  const jobId = source.jobId?.trim();
  if (!jobId) {
    return source;
  }

  const canonical = canonicalJobDatabasePath(jobsRoot, jobId);
  if (!existsSync(canonical)) {
    return source;
  }

  const stored = source.dbPath?.trim() ?? "";
  if (stored.length > 0 && path.normalize(stored) === path.normalize(canonical)) {
    return source;
  }

  return { ...source, dbPath: canonical };
}

export function resolveDataSourcesForWorkspace(
  config: AppDataSourcesFile,
  jobsRoot: string,
): AppDataSourcesFile {
  if (config.sources.length === 0) {
    return config;
  }

  return {
    ...config,
    sources: config.sources.map((source) =>
      resolveJobLinkedSourceForWorkspace(source, jobsRoot),
    ),
  };
}

/** Only linked source when the app has exactly one — strict count check. */
export function getSingleLinkedSource(
  config: AppDataSourcesFile,
): AppDataSource | undefined {
  return config.sources.length === 1 ? config.sources[0] : undefined;
}

/**
 * Default linked source for legacy configs and convenience fallbacks.
 * New apps should pass sourceId explicitly; this does not reintroduce "primary" as a feature.
 *
 * Order: single source → `primary` alias field → source with role "primary".
 */
export function getLegacyDefaultSource(
  config: AppDataSourcesFile,
): AppDataSource | undefined {
  const single = getSingleLinkedSource(config);
  if (single) {
    return single;
  }

  if (config.primary) {
    const byAlias = findDataSource(config, config.primary);
    if (byAlias) {
      return byAlias;
    }
  }

  return config.sources.find((s) => s.role === "primary");
}

/** @deprecated Use getLegacyDefaultSource — kept for callers migrating off "primary" naming. */
export function getPrimarySource(
  config: AppDataSourcesFile,
): AppDataSource | undefined {
  return getLegacyDefaultSource(config);
}

/** @deprecated No longer written — kept for tests migrating old configs. */
export function inferPrimaryAlias(sources: AppDataSource[]): string | undefined {
  return sources.length === 1 ? sources[0]?.alias : undefined;
}

/**
 * Find a linked source by unique id or by alias.
 *
 * Ids are matched before aliases, and matched exhaustively, because the two
 * namespaces are not equally trustworthy. An id is unique by construction; an
 * alias is a display name that can repeat — linking the same job twice, or two
 * jobs whose names collide, leaves several sources answering to one alias.
 *
 * The previous single `.find()` treated both namespaces as interchangeable and
 * returned whichever matched first. When an alias was duplicated that made the
 * result depend on array order: an app could read an empty database while its
 * data sat in the duplicate, with nothing anywhere reporting a problem. Empty
 * results are the hardest failure to trace, because they look like "no data
 * yet" rather than a bug.
 *
 * A duplicate alias is still resolved rather than rejected — throwing would
 * break working apps at read time for a mistake made at link time — but the
 * choice is now stable and it is reported loudly enough to find.
 */
export function findDataSource(
  config: AppDataSourcesFile,
  sourceId: string,
): AppDataSource | undefined {
  const byId = config.sources.find((s) => s.id === sourceId);
  if (byId) {
    return byId;
  }

  const byAlias = config.sources.filter((s) => s.alias === sourceId);
  if (byAlias.length > 1) {
    console.warn(
      `[AppDataSources] Alias "${sourceId}" matches ${byAlias.length} linked sources ` +
        `(${byAlias.map((s) => s.id).join(", ")}). Using the first. ` +
        `Pass a source id instead — aliases are display names and are not unique.`,
    );
  }
  return byAlias[0];
}

/** Extract the main table name from SQL (used by validation helpers). */
export function extractPrimaryTable(sql: string): string | null {
  const s = sql.trim();
  const patterns = [
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)/i,
    /\bREPLACE\s+INTO\s+["'`]?(\w+)/i,
    /\bUPDATE\s+(?:OR\s+\w+\s+)?["'`]?(\w+)/i,
    /\bDELETE\s+FROM\s+["'`]?(\w+)/i,
    /\bFROM\s+["'`]?(\w+)/i,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Resolve which linked data source to use.
 *
 * - Pass sourceId explicitly (alias) — same as naming the DB in backend code.
 * - If the app has exactly one linked source, sourceId may be omitted.
 * - Legacy: omitted sourceId + `primary` alias (or role "primary") resolves that source only.
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
  void options.sql;
  void options.tableExists;
  const { sourceId, operation = "read" } = options;
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
    return found;
  }

  if (sources.length === 1) {
    return sources[0];
  }

  const legacyDefault = getLegacyDefaultSource(config);
  if (legacyDefault && !sourceId) {
    return legacyDefault;
  }

  if (sources.length === 0) {
    throw Object.assign(
      new Error("No database is linked to this app. Use attach_database first."),
      { status: 400 },
    );
  }

  const aliases = sources.map((s) => `"${s.alias ?? s.id}"`).join(", ");
  throw Object.assign(
    new Error(
      `sourceId is required — this app has ${sources.length} linked databases (${aliases}). ` +
        `Pass sourceId on /api/db/${operation === "write" ? "write" : "query"} (e.g. sourceId: "billing").`,
    ),
    { status: 400 },
  );
}

/** @deprecated Mini-apps may read and write any linked source. */
export function assertWritableSource(
  _source: AppDataSource,
  _operation: DataSourceOperation,
): void {
  // intentionally no-op
}

/** True when the DB is missing, empty, or only has job infrastructure tables. */
export function dbHasOnlyBaselineTables(dbPath: string): boolean {
  try {
    if (!existsSync(dbPath)) {
      return true;
    }
    // Replica-managed registry DBs cannot be opened reliably with better-sqlite3.
    // A non-empty file means user/app data lives here (not scratch baseline).
    if (isReplicaManagedDbPath(dbPath)) {
      return statSync(dbPath).size === 0;
    }
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

export function buildAppDbTsContent(
  appId: string,
  sources: ReadonlyArray<{ alias: string }>,
): string {
  const aliases = sources.map((s) => s.alias);
  const aliasConst =
    aliases.length > 0
      ? `export const DB_SOURCES = ${JSON.stringify(aliases)} as const;\nexport type DbSourceId = (typeof DB_SOURCES)[number];\n`
      : "";

  return `const APP_ID = '${appId}';
${aliasConst}
export async function query<T>(
  sql: string,
  params: unknown[] = [],
  sourceId: string,
): Promise<T[]> {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, sourceId, sql, params }),
  });
  const json = (await res.json()) as { rows?: T[]; error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? \`DB query failed (\${res.status})\`);
  }
  return json.rows ?? [];
}

export async function exec(
  sql: string,
  params: unknown[] = [],
  sourceId: string,
): Promise<void> {
  const res = await fetch('/api/db/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, sourceId, sql, params }),
  });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? \`DB write failed (\${res.status})\`);
  }
}
`;
}
