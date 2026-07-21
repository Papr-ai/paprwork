/**
 * Workspace file listing for mini-app Files view (app source + linked jobs).
 */

import { promises as fs } from "fs";
import path from "path";
import type { Dirent } from "fs";

const APP_DIR_SKIP = new Set([
  ".versions",
  ".dist-staging",
  "node_modules",
]);

const JOB_DIR_SKIP = new Set([
  ".versions",
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  ".git",
]);

const READ_ONLY_EXTENSIONS = new Set([
  ".db",
  ".sqlite",
  ".sqlite3",
  ".pyc",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

export type WorkspaceFileKind = "file" | "database" | "sqlite-internal" | "log";

export interface WorkspaceFileEntry {
  path: string;
  kind: WorkspaceFileKind;
  readOnly: boolean;
}

export interface WorkspaceJobFiles {
  jobId: string;
  name: string;
  alias: string;
  files: WorkspaceFileEntry[];
}

export interface AppWorkspaceFilesResult {
  appId: string;
  appFiles: WorkspaceFileEntry[];
  jobs: WorkspaceJobFiles[];
}

function classifyFileKind(relativePath: string): WorkspaceFileKind {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".db-shm") || lower.endsWith(".db-wal")) {
    return "sqlite-internal";
  }
  if (/\.(db|sqlite|sqlite3)$/.test(lower)) {
    return "database";
  }
  if (lower.endsWith(".log")) {
    return "log";
  }
  return "file";
}

function isReadOnlyFile(relativePath: string, kind: WorkspaceFileKind): boolean {
  if (kind === "database" || kind === "sqlite-internal" || kind === "log") {
    return true;
  }
  const base = path.basename(relativePath);
  if (base.startsWith(".")) return true;
  const ext = path.extname(relativePath).toLowerCase();
  if (READ_ONLY_EXTENSIONS.has(ext)) return true;
  if (relativePath.startsWith("dist/") || relativePath === "dist") return true;
  return false;
}

async function walkDirectory(
  rootDir: string,
  skipDirs: Set<string>,
  includeDist: boolean,
): Promise<string[]> {
  const files: string[] = [];

  const walk = async (dir: string, relBase: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      if (!includeDist && entry.name === "dist") continue;

      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        files.push(rel);
      }
    }
  };

  await walk(rootDir, "");
  return files.sort((a, b) => a.localeCompare(b));
}

export async function listAppWorkspaceFiles(params: {
  appId: string;
  appsDir: string;
  listJobFiles: (
    jobId: string,
    jobName: string,
    alias: string,
  ) => Promise<WorkspaceJobFiles | null>;
  getDataSources: (appId: string) => Promise<{
    sources: Array<{ jobId?: string; dbId?: string; alias: string }>;
  }>;
}): Promise<AppWorkspaceFilesResult> {
  const appDir = path.join(params.appsDir, params.appId);
  const relativeFiles = await walkDirectory(appDir, APP_DIR_SKIP, true);

  const appFiles: WorkspaceFileEntry[] = relativeFiles.map((filePath) => {
    const kind = classifyFileKind(filePath);
    return {
      path: filePath,
      kind,
      readOnly: isReadOnlyFile(filePath, kind),
    };
  });

  const config = await params.getDataSources(params.appId);
  const jobs: WorkspaceJobFiles[] = [];

  for (const source of config.sources) {
    if (!source.jobId) {
      continue;
    }
    const jobFiles = await params.listJobFiles(
      source.jobId,
      source.alias,
      source.alias,
    );
    if (jobFiles) {
      jobs.push(jobFiles);
    }
  }

  return {
    appId: params.appId,
    appFiles,
    jobs,
  };
}

export async function listJobWorkspaceFiles(
  jobDir: string,
  jobId: string,
  name: string,
  alias: string,
): Promise<WorkspaceJobFiles | null> {
  try {
    await fs.access(jobDir);
  } catch {
    return null;
  }

  const relativeFiles = await walkDirectory(jobDir, JOB_DIR_SKIP, true);
  const files: WorkspaceFileEntry[] = relativeFiles.map((filePath) => {
    const kind = classifyFileKind(filePath);
    return {
      path: filePath,
      kind,
      readOnly: isReadOnlyFile(filePath, kind),
    };
  });

  return {
    jobId,
    name,
    alias,
    files,
  };
}

export function resolveJobFilePath(
  jobDir: string,
  filename: string,
): string | null {
  const resolvedPath = path.resolve(jobDir, filename);
  const resolvedDir = path.resolve(jobDir);
  if (
    !resolvedPath.startsWith(resolvedDir + path.sep) &&
    resolvedPath !== resolvedDir
  ) {
    return null;
  }
  return resolvedPath;
}
