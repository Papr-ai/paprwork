/**
 * Warn when bash/sqlite3 writes target non-canonical database paths.
 */

import path from "path";

const SQLITE_WRITE_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE\s+INTO)\b/i;

/** Extract filesystem paths ending in .db / .sqlite from a shell command. */
export function extractSqliteDbPaths(command: string): string[] {
  const paths = new Set<string>();

  const patterns = [
    /sqlite3\s+(["']?)([^\s"']+\.(?:db|sqlite))\1/gi,
    /sqlite3\.connect\s*\(\s*(["'])([^"']+\.(?:db|sqlite))\1/gi,
    /connect\s*\(\s*(["'])([^"']+\.(?:db|sqlite))\1/gi,
  ];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(command)) !== null) {
      const candidate = match[2] ?? match[3];
      if (candidate) paths.add(candidate);
    }
  }

  return [...paths];
}

/** True when command pipes SQL from a file into sqlite3 (writes bypass inline SQL detection). */
export function commandHasSqliteInputRedirect(command: string): boolean {
  return /sqlite3\s+[^\s]+\s*<\s*[^\s|&;]+/i.test(command);
}

export function commandHasSqliteWrite(command: string): boolean {
  if (!/sqlite3|\.connect\s*\(/i.test(command)) return false;
  if (commandHasSqliteInputRedirect(command)) return true;
  return SQLITE_WRITE_SQL_RE.test(command);
}

/** True when the command opens a SQLite database at all (read or write). */
export function commandTouchesSqlite(command: string): boolean {
  return /sqlite3|\.connect\s*\(/i.test(command);
}

/**
 * True when a sqlite3/python open is provably read-only.
 *
 * Opening a WAL database read-write auto-checkpoints on close and TRUNCATES
 * the WAL — even for a plain SELECT. For a replica-managed file that destroys
 * the frames the sync engine still has an offset into, which wedges sync in
 * both directions. So "no INSERT keyword" is NOT evidence of safety; only an
 * explicit read-only open is.
 *
 * Recognised read-only forms:
 *   sqlite3 "file:/path/data.db?mode=ro" "SELECT ..."
 *   sqlite3 -readonly /path/data.db "SELECT ..."
 *   sqlite3.connect("file:/path/data.db?mode=ro", uri=True)
 */
export function commandOpensSqliteReadOnly(command: string): boolean {
  if (/[?&]mode=ro\b/i.test(command)) return true;
  if (/(?:^|\s)-{1,2}readonly(?=\s|$)/i.test(command)) return true;
  return false;
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

export interface SqlitePathGuardContext {
  appDb?: string;
  jobDb?: string;
  /** Merged process + tool env (for PAPR_DB_* during job runs). */
  env?: NodeJS.ProcessEnv;
}

/** Collect PAPR_DB_* paths from process.env (multi-DB jobs). */
export function collectPaprDbPathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PAPR_DB_") || !value) continue;
    if (key.endsWith("_ALIAS") || key.endsWith("_ID")) continue;
    paths.push(value);
  }
  return paths;
}

export function buildSqlitePathWarnings(
  command: string,
  ctx: SqlitePathGuardContext = {},
): string[] {
  if (!commandHasSqliteWrite(command)) return [];

  const allowed = new Set<string>();
  if (ctx.appDb) allowed.add(normalizeDbPath(ctx.appDb));
  if (ctx.jobDb) allowed.add(normalizeDbPath(ctx.jobDb));
  if (process.env.APP_DB) allowed.add(normalizeDbPath(process.env.APP_DB));
  if (process.env.JOB_DB) allowed.add(normalizeDbPath(process.env.JOB_DB));
  const envSource = ctx.env ?? process.env;
  if (typeof envSource.APP_DB === "string") {
    allowed.add(normalizeDbPath(envSource.APP_DB));
  }
  if (typeof envSource.JOB_DB === "string") {
    allowed.add(normalizeDbPath(envSource.JOB_DB));
  }
  for (const paprDb of collectPaprDbPathsFromEnv(envSource)) {
    allowed.add(normalizeDbPath(paprDb));
  }

  const warnings: string[] = [];
  const targets = extractSqliteDbPaths(command);

  for (const target of targets) {
    const resolved = normalizeDbPath(target);
    if (allowed.size > 0 && allowed.has(resolved)) continue;

    const resolvedLower = resolved.toLowerCase();
    const paprApps = `${path.sep}papr${path.sep}apps${path.sep}`;
    const paprJobs = `${path.sep}papr${path.sep}jobs${path.sep}`;

    if (resolvedLower.includes(paprApps)) {
      warnings.push(
        `SQLite write to app-folder database "${target}" bypasses PAPR_DB_* routing. ` +
          `Mini-app data must go to PAPR_DB_* / $APP_DB (${ctx.appDb ?? "linked registry DB"}).`,
      );
      continue;
    }

    if (resolvedLower.includes(paprJobs)) {
      const canonicalSuffix = `${path.sep}data${path.sep}data.db`;
      if (!resolved.endsWith(canonicalSuffix) && !allowed.has(resolved)) {
        warnings.push(
          `SQLite write to non-canonical job path "${target}". ` +
            `Use $APP_DB for app tables or $JOB_DB (${ctx.jobDb ?? "jobDir/data/data.db"}) for scratch.`,
        );
      }
    }
  }

  return warnings;
}

export function formatSqlitePathWarningBlock(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return (
    "\n\n=== SQLite path warning ===\n" +
    warnings.map((w) => `- ${w}`).join("\n") +
    "\n"
  );
}

function hasRegistryWriteTargets(ctx: SqlitePathGuardContext): {
  appDb?: string;
  paprPaths: string[];
} {
  const env = ctx.env ?? process.env;
  const appDb =
    ctx.appDb ??
    (typeof env.APP_DB === "string" ? env.APP_DB : undefined);
  const paprPaths = collectPaprDbPathsFromEnv(env).map(normalizeDbPath);
  const hasWriteTargets =
    Boolean(appDb) ||
    Boolean(env.PAPR_WRITE_DB_IDS) ||
    paprPaths.length > 0;
  if (!hasWriteTargets) {
    return { paprPaths: [] };
  }
  return { appDb, paprPaths };
}

function commandReferencesJobDbScratch(command: string): boolean {
  if (/\$JOB_DB\b|environ\[['"]JOB_DB['"]\]|getenv\(['"]JOB_DB['"]\)/i.test(
    command,
  )) {
    return true;
  }
  return false;
}

function commandReferencesRegistryDb(
  command: string,
  appDb?: string,
  paprPaths: string[] = [],
): boolean {
  if (/\$APP_DB\b|PAPR_DB_|environ\[['"]APP_DB['"]\]/i.test(command)) {
    return true;
  }
  if (appDb) {
    const normalizedAppDb = normalizeDbPath(appDb);
    for (const target of extractSqliteDbPaths(command)) {
      if (normalizeDbPath(target) === normalizedAppDb) {
        return true;
      }
    }
  }
  for (const target of extractSqliteDbPaths(command)) {
    if (paprPaths.includes(normalizeDbPath(target))) {
      return true;
    }
  }
  return false;
}

/**
 * Block sqlite writes to $JOB_DB when the job has registry write targets injected.
 * Agent jobs often default to JOB_DB; mini-apps only read registry DBs via sourceId.
 */
export function detectScratchDbWriteWhenRegistryExpected(
  command: string,
  ctx: SqlitePathGuardContext = {},
): { message: string } | null {
  const { appDb, paprPaths } = hasRegistryWriteTargets(ctx);
  if (paprPaths.length === 0 && !appDb) {
    return null;
  }
  if (!commandHasSqliteWrite(command)) {
    return null;
  }
  if (commandReferencesRegistryDb(command, appDb, paprPaths)) {
    return null;
  }

  const env = ctx.env ?? process.env;
  const jobDbPath =
    ctx.jobDb ?? (typeof env.JOB_DB === "string" ? env.JOB_DB : undefined);
  const normalizedJobDb = jobDbPath ? normalizeDbPath(jobDbPath) : undefined;

  const writesJobDb =
    commandReferencesJobDbScratch(command) ||
    (normalizedJobDb !== undefined &&
      extractSqliteDbPaths(command).some(
        (target) => normalizeDbPath(target) === normalizedJobDb,
      ));

  if (!writesJobDb) {
    return null;
  }

  const primaryTarget =
    appDb ?? paprPaths[0] ?? "PAPR_DB_* from writeDbIds";
  return {
    message:
      `Blocked: sqlite write targets $JOB_DB (job scratch) but this job has registry write databases. ` +
      `Mini-apps read registry DBs via /api/db/query + sourceId — data in $JOB_DB is invisible to the app. ` +
      `Use papr_db.connect() / papr_db_exec, or sqlite3 on $APP_DB / PAPR_DB_* instead. ` +
      `Primary write target: ${primaryTarget}. $JOB_DB is for run logs and temp tables only.`,
  };
}
