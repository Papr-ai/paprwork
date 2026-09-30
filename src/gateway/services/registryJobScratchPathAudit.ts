/**
 * Audit databases.json for registry entries pointing at job scratch files
 * (Jobs/{jobId}/data/data.db). Those paths must stay local-only, not Plan A.
 */

import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";
import {
  DATABASES_REGISTRY_FILENAME,
  normalizeDbPath,
  type DatabaseRecord,
  type DatabasesRegistryFile,
} from "./DatabaseRegistryService.js";
import { isJobScratchDatabasePath } from "./jobs/jobScratchDatabasePath.js";

export interface RegistryJobScratchFinding {
  workspaceRoot: string;
  registryPath: string;
  dbId: string;
  localPath: string;
  syncMode?: string;
  ownerJobId?: string;
  tursoShortName: string;
  status: DatabaseRecord["status"];
}

export interface RegistryJobScratchAuditResult {
  scannedRegistries: number;
  findings: RegistryJobScratchFinding[];
}

export function isRegistryPathPointingAtJobScratch(localPath: string): boolean {
  return isJobScratchDatabasePath(normalizeDbPath(localPath));
}

export function auditDatabasesRegistryFile(
  file: DatabasesRegistryFile,
  context: { workspaceRoot: string; registryPath: string },
): RegistryJobScratchFinding[] {
  const findings: RegistryJobScratchFinding[] = [];
  for (const record of Object.values(file.databases ?? {})) {
    if (!isRegistryPathPointingAtJobScratch(record.localPath)) {
      continue;
    }
    findings.push({
      workspaceRoot: context.workspaceRoot,
      registryPath: context.registryPath,
      dbId: record.dbId,
      localPath: normalizeDbPath(record.localPath),
      syncMode: record.syncMode,
      ownerJobId: record.ownerJobId,
      tursoShortName: record.tursoShortName,
      status: record.status,
    });
  }
  return findings;
}

export async function discoverDatabasesRegistryPaths(
  paprBase: string,
): Promise<Array<{ workspaceRoot: string; registryPath: string }>> {
  const registries: Array<{ workspaceRoot: string; registryPath: string }> =
    [];

  const tryAdd = (workspaceRoot: string): void => {
    const registryPath = path.join(
      workspaceRoot,
      "data",
      DATABASES_REGISTRY_FILENAME,
    );
    if (existsSync(registryPath)) {
      registries.push({ workspaceRoot, registryPath });
    }
  };

  tryAdd(paprBase);

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return registries;
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
      tryAdd(path.join(namespacesDir, namespaceId));
    }
  }

  return registries;
}

export async function scanRegistryJobScratchPaths(options?: {
  paprBase?: string;
  /** Limit scan to one namespace workspace (papr home). */
  scopePaprHome?: string;
}): Promise<RegistryJobScratchAuditResult> {
  const paprBase = options?.paprBase ?? getPaprBaseDir();
  const scope = options?.scopePaprHome?.trim();
  const registryPaths = await discoverDatabasesRegistryPaths(paprBase);
  const filtered = scope
    ? registryPaths.filter(
        (entry) => path.normalize(entry.workspaceRoot) === path.normalize(scope),
      )
    : registryPaths;

  const findings: RegistryJobScratchFinding[] = [];

  for (const { workspaceRoot, registryPath } of filtered) {
    let raw: string;
    try {
      raw = await fs.readFile(registryPath, "utf8");
    } catch {
      continue;
    }
    let parsed: DatabasesRegistryFile;
    try {
      parsed = JSON.parse(raw) as DatabasesRegistryFile;
    } catch {
      continue;
    }
    findings.push(
      ...auditDatabasesRegistryFile(parsed, { workspaceRoot, registryPath }),
    );
  }

  return {
    scannedRegistries: filtered.length,
    findings,
  };
}
