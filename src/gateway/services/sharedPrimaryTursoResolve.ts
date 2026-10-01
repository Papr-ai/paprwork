/**
 * Read local install metadata (lineage + data-sources) to identify a team
 * track app's publisher slug/namespace for explicit install/db-token calls.
 * Routine replica sync uses memory ``/v1/cloud/databases/token`` ACL instead.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import type { CloudAppLineageFile } from "../../core/types/cloudAppLineage.js";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import {
  getDatabaseRegistryService,
  tursoNameForRecord,
} from "./DatabaseRegistryService.js";
import type { SharedPrimaryTursoEntry } from "./sharedPrimaryTursoStore.js";

export function lineageUsesSharedPrimaryDatabase(
  lineage: CloudAppLineageFile,
): boolean {
  if (lineage.databasePolicy === "forked") {
    return false;
  }
  if (lineage.databasePolicy === "shared") {
    return true;
  }
  return lineage.mode === "track";
}

/**
 * Read-only: map a Turso short name to publisher app identity from local
 * install metadata (lineage + data-sources). Does not write any registry file.
 *
 * Turso credentials for team shared DBs are authorized on the memory server
 * (``POST /v1/cloud/databases/token`` resolves publisher segment via ACL).
 * This helper is only for explicit install/db-token call sites that already
 * know they need publisher routing during install/bootstrap.
 */
export function resolveSharedPrimaryTursoEntry(
  tursoShortName: string,
  _paprDir?: string,
): SharedPrimaryTursoEntry | null {
  const normalized = tursoShortName.trim();
  if (!normalized) {
    return null;
  }

  const discovered = discoverSharedPrimaryTursoEntryFromApps(normalized);
  if (!discovered) {
    return null;
  }

  return {
    namespaceId: discovered.source.namespaceId,
    slug: discovered.source.slug,
    publisherUserId: discovered.source.userId,
    localAppId: discovered.localAppId,
    shareToken: discovered.shareToken,
  };
}

interface DiscoveredSharedPrimary {
  localAppId: string;
  source: CloudAppLineageFile["source"];
  registryDbIds: string[];
  shareToken?: string;
}

function discoverSharedPrimaryTursoEntryFromApps(
  tursoShortName: string,
): DiscoveredSharedPrimary | null {
  const appsRoot = getPaprAppsRoot();
  let appIds: string[];
  try {
    appIds = readdirSync(appsRoot);
  } catch {
    return null;
  }

  const registry = getDatabaseRegistryService();

  for (const appId of appIds) {
    const appDir = path.join(appsRoot, appId);
    let stat;
    try {
      stat = statSync(appDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    const lineage = readLineageSync(appDir);
    if (!lineage || !lineageUsesSharedPrimaryDatabase(lineage)) {
      continue;
    }

    const registryDbIds = readRegistryDbIdsSync(appDir);
    if (registryDbIds.length === 0) {
      continue;
    }

    for (const dbId of registryDbIds) {
      const record = registry.getById(dbId);
      if (!record || record.isolation === "per-user") {
        continue;
      }
      const shortName = tursoNameForRecord(record, lineage.source.userId);
      if (shortName === tursoShortName) {
        return {
          localAppId: appId,
          source: lineage.source,
          registryDbIds,
        };
      }
    }
  }

  return null;
}

function readLineageSync(appDir: string): CloudAppLineageFile | null {
  try {
    const raw = readFileSync(
      path.join(appDir, CLOUD_LINEAGE_FILENAME),
      "utf8",
    );
    return parseCloudAppLineageFile(raw);
  } catch {
    return null;
  }
}

function readRegistryDbIdsSync(appDir: string): string[] {
  try {
    const raw = readFileSync(path.join(appDir, "data-sources.json"), "utf8");
    const config = parseDataSourcesFile(raw);
    const ids: string[] = [];
    for (const source of config.sources) {
      const dbId = source.dbId?.trim();
      if (dbId) {
        ids.push(dbId);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * True when this desktop is a COLLABORATOR on a team-shared database: a local
 * app installed with the shared-primary policy points at it, and the app that
 * owns its schema is not on this desktop. The publisher migrates the shared
 * primary; collaborators only pull. Running migrations here replays them over
 * live team rows whenever the local ledger lags (Enrichment install, 2026-10).
 */
export function isCollaboratorOnSharedDatabase(dbId: string): boolean {
  const record = getDatabaseRegistryService().getById(dbId);
  if (!record || record.isolation === "per-user") {
    return false;
  }
  const owner = record.schemaOwnerAppId?.trim();
  const appsRoot = getPaprAppsRoot();
  if (owner) {
    try {
      if (statSync(path.join(appsRoot, owner)).isDirectory()) {
        return false;
      }
    } catch {
      /* owner app not on this desktop */
    }
  }
  let appIds: string[];
  try {
    appIds = readdirSync(appsRoot);
  } catch {
    return false;
  }
  for (const appId of appIds) {
    const appDir = path.join(appsRoot, appId);
    const lineage = readLineageSync(appDir);
    if (!lineage || !lineageUsesSharedPrimaryDatabase(lineage)) {
      continue;
    }
    if (readRegistryDbIdsSync(appDir).includes(dbId)) {
      return true;
    }
  }
  return false;
}
