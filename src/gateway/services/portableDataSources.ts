/**
 * Portable data-sources handling for shared / cloud-installed mini-apps.
 *
 * Absolute dbPath values from the publisher machine must not travel via git or
 * block Turso pull on another device. dbId / jobId are the portable identifiers;
 * dbPath is resolved locally from the registry or workspace layout.
 */

import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprDataDir, getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
  type AppDataSourcesFile,
} from "./appDataSources.js";
import {
  extractDatabaseSlugFromPath,
  resolveReadableRegistryDbPath,
  workspaceRegistryDbPath,
} from "./resolveRegistryDbPath.js";

/** True when dbPath is set but not readable on this machine. */
export function isUnreadableDbPath(dbPath: string | undefined): boolean {
  const trimmed = dbPath?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  try {
    return !existsSync(trimmed);
  } catch {
    return true;
  }
}

/**
 * Strip absolute dbPath before git push — same rule as BundleService export.
 * Preserves dbId and jobId so importers resolve paths locally.
 */
export function scrubDataSourcesForPortableSync(
  config: AppDataSourcesFile,
): AppDataSourcesFile {
  if (config.sources.length === 0) {
    return config;
  }

  return {
    ...config,
    sources: config.sources.map((source) => {
      if (!source.dbPath?.trim()) {
        return source;
      }
      if (!source.jobId && !source.dbId) {
        return source;
      }
      return { ...source, dbPath: "" };
    }),
  };
}

export async function scrubAppDataSourcesForGitSync(
  appDir: string,
): Promise<boolean> {
  const configPath = path.join(appDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return false;
  }

  const config = parseDataSourcesFile(raw);
  const scrubbed = scrubDataSourcesForPortableSync(config);
  const before = serializeDataSourcesFile(config);
  const after = serializeDataSourcesFile(scrubbed);
  if (before === after) {
    return false;
  }

  await fs.writeFile(configPath, after, "utf8");
  return true;
}

/**
 * Rewrite databases.json localPath entries to the active workspace using slug
 * extracted from the stored path (works across machines after git pull).
 */
export async function repairRegistryLocalPathsOnDisk(): Promise<number> {
  const { initializeDatabaseRegistry } = await import(
    "./DatabaseRegistryService.js"
  );
  const registry = await initializeDatabaseRegistry();
  const registryPath = registry.getRegistryPath();
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, "utf8");
  } catch {
    return 0;
  }

  const dataDir = getPaprDataDir();
  let parsed: { databases?: Record<string, { localPath?: string }> };
  try {
    parsed = JSON.parse(raw) as { databases?: Record<string, { localPath?: string }> };
  } catch {
    return 0;
  }

  if (!parsed.databases) {
    return 0;
  }

  let repairs = 0;
  for (const [dbId, record] of Object.entries(parsed.databases)) {
    const stored = record?.localPath?.trim() ?? "";
    if (!stored) {
      continue;
    }

    const slug = extractDatabaseSlugFromPath(stored);
    if (!slug) {
      continue;
    }

    const target = workspaceRegistryDbPath(slug, dataDir);
    if (path.normalize(stored) === path.normalize(target)) {
      continue;
    }

    await registry.updateLocalPath(dbId, target);
    repairs += 1;
  }

  return repairs;
}

/**
 * Repair data-sources.json + registry for the active workspace.
 * Run after cloud install or git pull before Turso sync.
 */
export async function repairWorkspacePortableDataSources(): Promise<{
  registryRepairs: number;
  dataSourceRepairs: number;
}> {
  const registryRepairs = await repairRegistryLocalPathsOnDisk();

  const { runGlobalDataSourcePathRepair } = await import(
    "./dataSourcePathRepairScan.js"
  );
  const scan = await runGlobalDataSourcePathRepair({
    scopePaprHome: getPaprRoot(),
  });

  return {
    registryRepairs,
    dataSourceRepairs: scan.repairCount,
  };
}

/**
 * Resolve dbPath for Turso discovery when data-sources.json still has a
 * foreign or empty path after sync.
 */
export async function resolveLinkedSourceDbPath(input: {
  dbPath?: string;
  dbId?: string;
  jobId?: string;
  jobsRoot: string;
}): Promise<string | null> {
  const stored = input.dbPath?.trim() ?? "";
  if (stored && existsSync(stored)) {
    return path.normalize(stored);
  }

  if (input.jobId) {
    const canonical = path.join(
      input.jobsRoot,
      input.jobId,
      "data",
      "data.db",
    );
    if (existsSync(canonical)) {
      return canonical;
    }
    return canonical;
  }

  const dataDir = getPaprDataDir();
  const { getDatabaseRegistryService } = await import(
    "./DatabaseRegistryService.js"
  );
  const registry = getDatabaseRegistryService();
  const record = input.dbId ? registry.getById(input.dbId) : undefined;

  const readable = resolveReadableRegistryDbPath({
    dbPath: stored,
    registryPath: record?.localPath,
    dataDir,
  });
  if (readable) {
    return readable;
  }

  const slug = extractDatabaseSlugFromPath(stored || record?.localPath || "");
  if (slug) {
    return workspaceRegistryDbPath(slug, dataDir);
  }

  return stored || null;
}
