/**
 * Apply per-user Turso isolation to registry databases linked to a mini-app.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import {
  getDatabaseRegistryService,
  type DatabaseIsolation,
} from "./DatabaseRegistryService.js";
import { writeLinkedDatabasesForApp } from "./cloudSync/linkedDatabasesForCloud.js";

export interface ApplyPerUserIsolationResult {
  updatedDbIds: string[];
  skippedJobOnlySources: number;
  missingDbIds: string[];
}

export async function applyPerUserIsolationForApp(
  appId: string,
  enabled: boolean,
  paprDir?: string,
): Promise<ApplyPerUserIsolationResult> {
  const root = paprDir ?? getPaprRoot();
  const appDir = path.join(root, "apps", appId);
  const configPath = path.join(appDir, "data-sources.json");

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { updatedDbIds: [], skippedJobOnlySources: 0, missingDbIds: [] };
  }

  const config = parseDataSourcesFile(raw);
  const registry = getDatabaseRegistryService();
  const isolation: DatabaseIsolation = enabled ? "per-user" : "shared";
  const updatedDbIds: string[] = [];
  const missingDbIds: string[] = [];
  let skippedJobOnlySources = 0;

  const seenDbIds = new Set<string>();
  for (const source of config.sources) {
    const dbId = source.dbId?.trim();
    if (!dbId) {
      if (source.jobId?.trim()) {
        skippedJobOnlySources += 1;
      }
      continue;
    }
    if (seenDbIds.has(dbId)) {
      continue;
    }
    seenDbIds.add(dbId);

    try {
      await registry.setIsolation(dbId, isolation);
      updatedDbIds.push(dbId);
    } catch {
      missingDbIds.push(dbId);
    }
  }

  if (updatedDbIds.length > 0) {
    await writeLinkedDatabasesForApp(root, appId);
  }

  return { updatedDbIds, skippedJobOnlySources, missingDbIds };
}
