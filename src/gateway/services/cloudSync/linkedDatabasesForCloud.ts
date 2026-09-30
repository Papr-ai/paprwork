/**
 * Portable database registry slice for cloud mini-apps.
 *
 * Cloud data-sources.json strips machine-specific dbPath values. Turso routing
 * needs dbId → tursoShortName/isolation from the registry. Workspace-level
 * data/databases.json is easy to miss on app-only uploads, so each app ships
 * linked-databases.json beside data-sources.json during cloud prep.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { parseDataSourcesFile } from "../appDataSources.js";
import type { DatabasesRegistryFile, DatabaseRecord } from "../DatabaseRegistryService.js";
import { DATABASES_REGISTRY_FILENAME } from "../DatabaseRegistryService.js";

export const LINKED_DATABASES_FILENAME = "linked-databases.json";

export interface LinkedDatabasesExportResult {
  written: boolean;
  dbIds: string[];
  missingDbIds: string[];
}

function portableRecord(record: DatabaseRecord): DatabaseRecord {
  return {
    ...record,
    localPath: "",
  };
}

/** Write apps/{appId}/linked-databases.json for dbIds referenced in data-sources. */
export async function writeLinkedDatabasesForApp(
  paprDir: string,
  appId: string,
): Promise<LinkedDatabasesExportResult> {
  const appDir = path.join(paprDir, "apps", appId);
  const dataSourcesPath = path.join(appDir, "data-sources.json");
  const outputPath = path.join(appDir, LINKED_DATABASES_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(dataSourcesPath, "utf8");
  } catch {
    return { written: false, dbIds: [], missingDbIds: [] };
  }

  const config = parseDataSourcesFile(raw);
  const dbIds = [
    ...new Set(
      config.sources
        .map((source) => source.dbId?.trim())
        .filter((dbId): dbId is string => Boolean(dbId)),
    ),
  ].sort();

  if (dbIds.length === 0) {
    try {
      await fs.unlink(outputPath);
    } catch {
      /* no stale file */
    }
    return { written: false, dbIds: [], missingDbIds: [] };
  }

  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  let registryFile: DatabasesRegistryFile = { version: 1, databases: {} };
  try {
    const registryRaw = await fs.readFile(registryPath, "utf8");
    registryFile = JSON.parse(registryRaw) as DatabasesRegistryFile;
  } catch {
    /* no workspace registry yet */
  }

  const databases: Record<string, DatabaseRecord> = {};
  const missingDbIds: string[] = [];
  for (const dbId of dbIds) {
    const record = registryFile.databases[dbId];
    if (!record || record.status === "tombstone") {
      missingDbIds.push(dbId);
      continue;
    }
    databases[dbId] = portableRecord(record);
  }

  const payload: DatabasesRegistryFile = { version: 1, databases };
  const next = `${JSON.stringify(payload, null, 2)}\n`;

  let previous = "";
  try {
    previous = await fs.readFile(outputPath, "utf8");
  } catch {
    /* first write */
  }

  if (previous !== next) {
    await fs.writeFile(outputPath, next, "utf8");
  }

  if (missingDbIds.length > 0) {
    console.warn(
      `[CloudSync] linked-databases.json for ${appId} missing registry entries: ${missingDbIds.join(", ")}`,
    );
  }

  return {
    written: previous !== next,
    dbIds,
    missingDbIds,
  };
}
