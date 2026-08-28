/**
 * Block raw SQLite DDL via bash on synced job/registry databases.
 * Schema changes must go through migrations/*.sql so local + Turso stay aligned.
 */

import path from "path";
import {
  extractSqliteDbPaths,
  type SqlitePathGuardContext,
} from "./sqlitePathGuard.js";

const SQLITE_DDL_RE =
  /\b(ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TABLE|DROP\s+(?:TABLE|INDEX)|RENAME\s+TABLE)\b/i;

const ENV_DB_VAR_RE = /\$(?:\{)?(JOB_DB|APP_DB|PAPR_DB_[A-Z0-9_]+)(?:\})?/g;

export interface JobDbSchemaDdlBlock {
  message: string;
  migrationPath: string;
  suggestedSql: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(2));
  }
  return p;
}

function normalizeDbPath(p: string): string {
  return path.resolve(expandHome(p.replace(/^["']|["']$/g, "")));
}

function posixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/** True when this db file is synced to Turso (job or registry layout). */
export function isSyncedPaprDatabasePath(resolvedPath: string): boolean {
  const n = posixPath(resolvedPath);
  if (/\/Jobs\/[^/]+\/data\/data\.db$/i.test(n)) {
    return true;
  }
  if (/\/databases\/[^/]+\/data\.db$/i.test(n)) {
    return true;
  }
  return false;
}

export function commandHasSqliteDdl(command: string): boolean {
  if (!/sqlite3|\.execute\s*\(|\.executescript\s*\(/i.test(command)) {
    return false;
  }
  return SQLITE_DDL_RE.test(command);
}

function extractQuotedSqlFragments(command: string): string[] {
  const fragments: string[] = [];
  const patterns = [
    /sqlite3\s+(?:["'][^"']+["']\s+)?(["'])((?:\\.|(?!\1).)*)\1/gi,
    /\.execute\s*\(\s*(["'])((?:\\.|(?!\2).)*)\1/gi,
    /\.executescript\s*\(\s*(["'])((?:\\.|(?!\2).)*)\1/gi,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(command)) !== null) {
      const sql = match[2]?.trim();
      if (sql && SQLITE_DDL_RE.test(sql)) {
        fragments.push(sql);
      }
    }
  }
  if (fragments.length === 0 && SQLITE_DDL_RE.test(command)) {
    const ddlMatch = command.match(
      /\b((?:ALTER|CREATE|DROP|RENAME)\s+(?:TABLE|INDEX|UNIQUE INDEX)[\s\S]*?)(?:;|$)/i,
    );
    if (ddlMatch?.[1]) {
      fragments.push(ddlMatch[1].trim());
    }
  }
  return fragments;
}

function jobIdFromDbPath(resolvedPath: string): string | null {
  const n = posixPath(resolvedPath);
  const jobMatch = n.match(/\/Jobs\/([^/]+)\/data\/data\.db$/i);
  return jobMatch?.[1] ?? null;
}

function registrySlugFromDbPath(resolvedPath: string): string | null {
  const n = posixPath(resolvedPath);
  const slugMatch = n.match(/\/databases\/([^/]+)\/data\.db$/i);
  return slugMatch?.[1] ?? null;
}

export function migrationPathForDb(resolvedPath: string): string {
  const jobId = jobIdFromDbPath(resolvedPath);
  if (jobId) {
    return `$PAPR_HOME/Jobs/${jobId}/migrations/000N_description.sql`;
  }
  const slug = registrySlugFromDbPath(resolvedPath);
  if (slug) {
    return `$PAPR_HOME/data/databases/${slug}/migrations/000N_description.sql`;
  }
  return `$PAPR_HOME/.../migrations/000N_description.sql`;
}

function collectDbTargets(
  command: string,
  ctx: SqlitePathGuardContext = {},
): string[] {
  const envSource = ctx.env ?? process.env;
  const targets = new Set<string>();

  for (const raw of extractSqliteDbPaths(command)) {
    if (/^\$/.test(raw)) {
      const varName = raw.replace(/^\$\{?|\}?$/g, "");
      const value = envSource[varName];
      if (typeof value === "string" && value.length > 0) {
        targets.add(normalizeDbPath(value));
      }
      continue;
    }
    targets.add(normalizeDbPath(raw));
  }

  let envMatch: RegExpExecArray | null;
  const re = new RegExp(ENV_DB_VAR_RE.source, ENV_DB_VAR_RE.flags);
  while ((envMatch = re.exec(command)) !== null) {
    const varName = envMatch[1];
    const value = envSource[varName];
    if (typeof value === "string" && value.length > 0) {
      targets.add(normalizeDbPath(value));
    }
  }

  return [...targets];
}

function buildBlockMessage(
  dbPath: string,
  ddlStatements: string[],
): JobDbSchemaDdlBlock {
  const migrationPath = migrationPathForDb(dbPath);
  const suggestedSql =
    ddlStatements.length > 0
      ? `${ddlStatements.map((s) => (s.endsWith(";") ? s : `${s};`)).join("\n\n")}\n`
      : "-- Paste your ALTER TABLE / CREATE TABLE statements here\n";

  const jobId = jobIdFromDbPath(dbPath);
  const slug = registrySlugFromDbPath(dbPath);
  const applyStep = slug
    ? `2. papr_db_apply_migration({ dbId: "<from databases.json>", migrationId: "0002_add_columns" })`
    : jobId
      ? `2. run_job({ jobId: "${jobId}" }) — applies Jobs/${jobId}/migrations/ locally`
      : `2. Apply migration via papr_db_apply_migration (registry) or run_job (job scratch)`;
  const syncStep =
    `3. papr_db_push({ dbId }) or Upload now / push_cloud_sync({ appId }) — Plan A replica sync\n` +
    `   Do not use raw sqlite3 DDL on synced databases.`;

  const message =
    "⛔ Do not change synced SQLite table structure via bash/sqlite3. " +
    "Use a migration file so the same DDL runs locally and on Turso primary.\n\n" +
    `Instead:\n` +
    `1. write_file({ path: "${migrationPath.replace("000N_description", "0002_add_columns")}", content: ... })\n` +
    `   Registry (app) DBs: $PAPR_HOME/data/databases/{slug}/migrations/\n` +
    `   Job scratch only: $PAPR_HOME/Jobs/{jobId}/migrations/\n` +
    `${applyStep}\n` +
    `${syncStep}\n\n` +
    "Suggested SQL:\n" +
    suggestedSql.trim();

  return { message, migrationPath, suggestedSql };
}

/**
 * Returns a block payload when bash would run DDL against a synced Papr database.
 */
export function detectJobDbSchemaDdlBlock(
  command: string,
  ctx: SqlitePathGuardContext = {},
): JobDbSchemaDdlBlock | null {
  if (!commandHasSqliteDdl(command)) {
    return null;
  }

  const ddlStatements = extractQuotedSqlFragments(command);
  const targets = collectDbTargets(command, ctx);

  for (const target of targets) {
    if (!isSyncedPaprDatabasePath(target)) {
      continue;
    }
    return buildBlockMessage(target, ddlStatements);
  }

  return null;
}

export const JOB_DB_SCHEMA_DDL_SCAN_RE =
  /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|RENAME\s+TABLE)\b/i;

/** Scan job source for inline DDL (anti-pattern vs migrations/*.sql). */
export function scanSourceForSchemaDdlAntiPattern(content: string): string[] {
  const warnings: string[] = [];
  if (!JOB_DB_SCHEMA_DDL_SCAN_RE.test(content)) {
    return warnings;
  }

  const patterns = [
    /\.execute\s*\(\s*["']([^"']*(?:ALTER|CREATE|DROP|RENAME)\s+TABLE[^"']*)["']/gi,
    /\.executescript\s*\(\s*["']([^"']*(?:ALTER|CREATE|DROP|RENAME)\s+TABLE[^"']*)["']/gi,
    /sqlite3[^\\n]*["']([^"']*(?:ALTER|CREATE|DROP|RENAME)\s+TABLE[^"']*)["']/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const snippet = match[1]?.trim().slice(0, 80) ?? "";
      warnings.push(
        `Inline schema DDL detected (\`${snippet}...\`). ` +
          `Move DDL to migrations/000N_description.sql via write_file — ` +
          `registry DBs: papr_db_apply_migration; job scratch: Jobs/{jobId}/migrations/ + run_job.`,
      );
    }
  }

  if (warnings.length === 0) {
    warnings.push(
      "Source may contain SQLite schema DDL (ALTER/CREATE/DROP TABLE). " +
        "Use migrations/*.sql via write_file instead of inline DDL in scripts.",
    );
  }

  return [...new Set(warnings)];
}
