/**
 * Discover job SQLite databases referenced in mini-app source (reads/writes in code).
 */

import { promises as fs } from "fs";
import path from "path";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".vue",
  ".mjs",
  ".cjs",
]);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "backend",
]);

export interface CodeDiscoveredJobReference {
  jobId: string;
  dbPath: string;
  matchedBy: "db_path" | "job_id" | "api_db" | "papar_home_path";
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function listScannableAppFiles(appDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (isCodeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  await walk(appDir);
  return files;
}

function normalizeDbPath(rawPath: string): string {
  return path.normalize(rawPath.replace(/\$/g, ""));
}

function extractJobIdFromDbPath(dbPath: string): string | null {
  const match = dbPath.match(
    /[/\\](?:Jobs|jobs)[/\\]([0-9a-f-]{36})[/\\]data[/\\][^/\\]+\.db/i,
  );
  return match?.[1] ?? null;
}

function addJobReference(
  results: Map<string, CodeDiscoveredJobReference>,
  jobId: string,
  dbPath: string,
  matchedBy: CodeDiscoveredJobReference["matchedBy"],
): void {
  const normalizedPath = path.normalize(dbPath);
  const existing = results.get(jobId);
  if (existing) {
    return;
  }
  results.set(jobId, { jobId, dbPath: normalizedPath, matchedBy });
}

async function jobDbExists(jobsRoot: string, jobId: string): Promise<string | null> {
  const dbPath = path.join(jobsRoot, jobId, "data", "data.db");
  try {
    await fs.access(dbPath);
    return dbPath;
  } catch {
    return null;
  }
}

/**
 * Scan app code for SQLite job databases the mini-app reads or writes.
 * Includes dist/ (bundled runtime) but skips backend/ and node_modules/.
 */
export async function scanAppCodeForJobDatabaseReferences(input: {
  appDir: string;
  jobsRoot: string;
}): Promise<CodeDiscoveredJobReference[]> {
  const results = new Map<string, CodeDiscoveredJobReference>();
  const files = await listScannableAppFiles(input.appDir);

  const dbPathPattern =
    /(?:\$PAPR_HOME[/\\]|~[/\\]Papr[/\\]|(?:[/\\]|^)(?:Papr[/\\](?:orgs[/\\][^/\\]+[/\\]namespaces[/\\][^/\\]+[/\\])?(?:Jobs|jobs)))[/\\][^'"`\s]+\.db/gi;

  const paparJobsPathPattern =
    /\$PAPR_HOME[/\\](?:Jobs|jobs)[/\\]([0-9a-f-]{36})[/\\]data[/\\][^'"`\s]+\.db/gi;

  const jobIdPattern = /['"`]([0-9a-f-]{36})['"`]/g;

  const apiDbJobIdPattern =
    /\/api\/db\/(?:query|write|exec|schema)[\s\S]{0,1200}?\bjobId\s*:\s*['"`]([0-9a-f-]{36})['"`]/gi;

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    for (const match of content.matchAll(dbPathPattern)) {
      const rawPath = match[0];
      const jobId = extractJobIdFromDbPath(rawPath);
      if (!jobId) {
        continue;
      }
      const resolved =
        rawPath.includes("$PAPR_HOME") || rawPath.startsWith("~")
          ? path.join(input.jobsRoot, jobId, "data", path.basename(rawPath))
          : normalizeDbPath(rawPath);
      addJobReference(results, jobId, resolved, "db_path");
    }

    for (const match of content.matchAll(paparJobsPathPattern)) {
      const jobId = match[1];
      const dbPath = await jobDbExists(input.jobsRoot, jobId);
      if (dbPath) {
        addJobReference(results, jobId, dbPath, "papar_home_path");
      }
    }

    for (const match of content.matchAll(apiDbJobIdPattern)) {
      const jobId = match[1];
      const dbPath = await jobDbExists(input.jobsRoot, jobId);
      if (dbPath) {
        addJobReference(results, jobId, dbPath, "api_db");
      }
    }

    for (const match of content.matchAll(jobIdPattern)) {
      const jobId = match[1];
      const dbPath = await jobDbExists(input.jobsRoot, jobId);
      if (!dbPath) {
        continue;
      }
      if (
        /\/api\/db\//i.test(content) ||
        /\.db\b/i.test(content) ||
        /fetch\s*\(/i.test(content)
      ) {
        addJobReference(results, jobId, dbPath, "job_id");
      }
    }
  }

  return [...results.values()];
}
