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

export function commandHasSqliteWrite(command: string): boolean {
  if (!/sqlite3|\.connect\s*\(/i.test(command)) return false;
  return SQLITE_WRITE_SQL_RE.test(command);
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

  const warnings: string[] = [];
  const targets = extractSqliteDbPaths(command);

  for (const target of targets) {
    const resolved = normalizeDbPath(target);
    if (allowed.size > 0 && allowed.has(resolved)) continue;

    const paprApps = `${path.sep}Papr${path.sep}apps${path.sep}`;
    const paprJobs = `${path.sep}Papr${path.sep}jobs${path.sep}`;

    if (resolved.includes(paprApps)) {
      warnings.push(
        `SQLite write to app-folder database "${target}" bypasses APP_DB routing. ` +
          `Mini-app data must go to $APP_DB (${ctx.appDb ?? "primary linked job DB"}).`,
      );
      continue;
    }

    if (resolved.includes(paprJobs)) {
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
