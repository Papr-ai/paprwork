/**
 * Offline scan/repair for stale data-sources.json dbPath values across all workspaces.
 * Safe to run while Gateway is stopped, or alongside it (idempotent writes).
 */

import { existsSync, type Dirent } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";
import type { AppDataSourcesFile } from "./appDataSources.js";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
} from "./appDataSources.js";
import {
  buildJobDatabasePathIndex,
  createJobPathResolverForDataSourcesFile,
} from "./jobDatabasePathIndex.js";
import { repairDataSourceDbPathsInConfig } from "./repairDataSourceDbPaths.js";

export interface DataSourcePathRepairScanOptions {
  paprBase?: string;
  dryRun?: boolean;
  /** Pause between apps so long scans do not monopolize the event loop. */
  delayMs?: number;
  /** Only repair data-sources.json under this workspace papr home. */
  scopePaprHome?: string;
}

export interface DataSourcePathRepairScanResult {
  scannedApps: number;
  repairedApps: number;
  repairCount: number;
  repairs: Array<{
    appId: string;
    dataSourcesPath: string;
    alias: string;
    jobId?: string;
    fromPath: string;
    toPath: string;
  }>;
}

async function collectDataSourcesFiles(
  appsDir: string,
  out: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dataSourcesPath = path.join(appsDir, entry.name, "data-sources.json");
    if (existsSync(dataSourcesPath)) {
      out.push(dataSourcesPath);
    }
  }
}

export async function discoverDataSourcesFiles(
  paprBase: string,
): Promise<string[]> {
  const files: string[] = [];

  await collectDataSourcesFiles(path.join(paprBase, "apps"), files);

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return files;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      await collectDataSourcesFiles(
        path.join(namespacesDir, namespaceId, "apps"),
        files,
      );
    }
  }

  return files;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runGlobalDataSourcePathRepair(
  options: DataSourcePathRepairScanOptions = {},
): Promise<DataSourcePathRepairScanResult> {
  const paprBase = options.paprBase ?? getPaprBaseDir();
  const dryRun = options.dryRun ?? false;
  const delayMs = options.delayMs ?? 25;
  const scopePaprHome = options.scopePaprHome;

  const jobIndex = await buildJobDatabasePathIndex(paprBase);
  const { getDatabaseRegistryService } = await import(
    "./DatabaseRegistryService.js"
  );
  await getDatabaseRegistryService().initialize();
  let dataSourcesPaths = await discoverDataSourcesFiles(paprBase);
  if (scopePaprHome) {
    const scopeRoot = path.join(scopePaprHome, "apps") + path.sep;
    dataSourcesPaths = dataSourcesPaths.filter((filePath) =>
      filePath.startsWith(scopeRoot),
    );
  }

  const result: DataSourcePathRepairScanResult = {
    scannedApps: dataSourcesPaths.length,
    repairedApps: 0,
    repairCount: 0,
    repairs: [],
  };

  for (const dataSourcesPath of dataSourcesPaths) {
    const appId = path.basename(path.dirname(dataSourcesPath));
    let raw: string;
    try {
      raw = await fs.readFile(dataSourcesPath, "utf8");
    } catch {
      continue;
    }

    let config: AppDataSourcesFile;
    try {
      config = parseDataSourcesFile(raw);
    } catch {
      console.warn(
        `[repair:data-sources] Skipping ${dataSourcesPath}: invalid JSON`,
      );
      await delay(delayMs);
      continue;
    }

    if (config.sources.length === 0) {
      await delay(delayMs);
      continue;
    }

    const resolver = createJobPathResolverForDataSourcesFile(
      dataSourcesPath,
      paprBase,
      jobIndex,
    );

    const { config: repairedConfig, repairs } =
      await repairDataSourceDbPathsInConfig(appId, config, resolver);

    if (repairs.length === 0) {
      await delay(delayMs);
      continue;
    }

    result.repairedApps += 1;
    result.repairCount += repairs.length;

    for (const repair of repairs) {
      result.repairs.push({ ...repair, dataSourcesPath });
      console.log(
        `[repair:data-sources] ${dryRun ? "(dry-run) " : ""}` +
          `app ${repair.appId} (${repair.alias}, job ${repair.jobId}): ` +
          `${repair.fromPath} → ${repair.toPath}`,
      );
    }

    if (!dryRun) {
      await fs.writeFile(
        dataSourcesPath,
        `${serializeDataSourcesFile(repairedConfig)}\n`,
        "utf8",
      );
    }

    await delay(delayMs);
  }

  return result;
}
