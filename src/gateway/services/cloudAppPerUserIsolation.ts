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
import { shouldUseTursoReplicaForDb } from "../utils/tursoReplicaEnabled.js";

export interface ApplyPerUserIsolationResult {
  updatedDbIds: string[];
  skippedJobOnlySources: number;
  missingDbIds: string[];
  reseededDbIds: string[];
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
    return {
      updatedDbIds: [],
      skippedJobOnlySources: 0,
      missingDbIds: [],
      reseededDbIds: [],
    };
  }

  const config = parseDataSourcesFile(raw);
  const registry = getDatabaseRegistryService();
  const isolation: DatabaseIsolation = enabled ? "per-user" : "shared";
  const updatedDbIds: string[] = [];
  const missingDbIds: string[] = [];
  const reseededDbIds: string[] = [];
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
      const record = await registry.setIsolation(dbId, isolation);
      updatedDbIds.push(dbId);

      if (shouldUseTursoReplicaForDb({ syncMode: record.syncMode })) {
        const { reseedTursoReplicaFromRemote } = await import(
          "./tursoReplica/tursoReplicaProvision.js"
        );
        await reseedTursoReplicaFromRemote(record);
        reseededDbIds.push(dbId);
      }
    } catch {
      missingDbIds.push(dbId);
    }
  }

  if (updatedDbIds.length > 0) {
    await writeLinkedDatabasesForApp(root, appId);
  }

  return { updatedDbIds, skippedJobOnlySources, missingDbIds, reseededDbIds };
}

/**
 * Validate per-user publish config: linked registry DBs must exist and match isolation.
 */
export async function validatePerUserIsolationForPublish(
  appId: string,
  paprDir?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = paprDir ?? getPaprRoot();
  const configPath = path.join(root, "apps", appId, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { ok: true };
  }

  const config = parseDataSourcesFile(raw);
  const registry = getDatabaseRegistryService();
  const missing: string[] = [];
  const wrongIsolation: string[] = [];

  for (const source of config.sources) {
    const dbId = source.dbId?.trim();
    if (!dbId) {
      continue;
    }
    const record = registry.getById(dbId);
    if (!record || record.status !== "active") {
      missing.push(dbId);
      continue;
    }
    if (record.isolation !== "per-user") {
      wrongIsolation.push(dbId);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Per-user isolation requires linked registry databases. Missing: ${missing.join(", ")}`,
    };
  }
  if (wrongIsolation.length > 0) {
    return {
      ok: false,
      error:
        `Linked databases must use isolation=per-user before publish: ${wrongIsolation.join(", ")}`,
    };
  }
  return { ok: true };
}
