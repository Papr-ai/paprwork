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
  /**
   * per-user → shared: tables that every signed-in user will now see.
   * Nothing is rewritten automatically (rows keep `_acl` NULL = public); the
   * agent decides with the user which to make private via
   * papr_db_set_table_access and an optional backfill migration.
   */
  sharedExposure?: Array<{ dbId: string; publicTables: string[] }>;
}

const lastSharedExposure = new Map<string, Array<{ dbId: string; publicTables: string[] }>>();

/** Read-once: exposure report from the most recent per-user → shared switch for an app. */
export function takeSharedExposure(
  appId: string,
): Array<{ dbId: string; publicTables: string[] }> | undefined {
  const v = lastSharedExposure.get(appId);
  lastSharedExposure.delete(appId);
  return v;
}

/** User tables that stay public after a DB becomes shared (sync/engine tables excluded). */
export function publicTablesAfterShare(
  allTables: ReadonlyArray<string>,
  privateTables: ReadonlySet<string>,
): string[] {
  return allTables
    .map((t) => t.toLowerCase())
    .filter(
      (t) =>
        !privateTables.has(t) &&
        !/^(_papr_|__papr|turso_|libsql_|sqlite_|_litestream)/.test(t) &&
        t !== "schema_migrations",
    )
    .sort();
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
  const sharedExposure: Array<{ dbId: string; publicTables: string[] }> = [];

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
      const wasPerUser = registry.getById(dbId)?.isolation === "per-user";
      const record = await registry.setIsolation(dbId, isolation);
      if (!enabled && wasPerUser) {
        // The owner's base DB becomes the shared one; other users' per-user
        // copies are not merged in. Report what becomes visible to everyone.
        try {
          const { paprDbQuery } = await import("./tursoReplica/PaprDbService.js");
          const { privateTablesOf } = await import("./DatabaseRegistryService.js");
          const rows = await paprDbQuery({
            dbId,
            sql: "SELECT name FROM sqlite_master WHERE type='table'",
          });
          const publicTables = publicTablesAfterShare(
            rows.rows.map((r) => String(r.name ?? "")),
            privateTablesOf(record),
          );
          if (publicTables.length) sharedExposure.push({ dbId, publicTables });
        } catch {
          /* best effort — never block the isolation change */
        }
      }
      updatedDbIds.push(dbId);

      if (shouldUseTursoReplicaForDb({ syncMode: record.syncMode })) {
        const { reseedTursoReplicaFromRemote } = await import(
          "./tursoReplica/tursoReplicaProvision.js"
        );
        // Switching primaries: the shared DB's rows must not be replayed into a per-user DB.
        await reseedTursoReplicaFromRemote(record, { localRows: "discard" });
        reseededDbIds.push(dbId);
      }
    } catch {
      missingDbIds.push(dbId);
    }
  }

  if (updatedDbIds.length > 0) {
    await writeLinkedDatabasesForApp(root, appId);
  }

  if (sharedExposure.length) lastSharedExposure.set(appId, sharedExposure);
  return {
    updatedDbIds,
    skippedJobOnlySources,
    missingDbIds,
    reseededDbIds,
    ...(sharedExposure.length ? { sharedExposure } : {}),
  };
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
