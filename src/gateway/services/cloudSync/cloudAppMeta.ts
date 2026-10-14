/**
 * Per-app cloud metadata — dist revision + required Turso schema version.
 */

import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { discoverTursoLinkedSources } from "../tursoLinkedSources.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { listAppliedMigrationIdsReadOnly } from "../jobs/schemaMigrationsLedger.js";
import { requiredSchemaVersionFromMigrationIds } from "../jobs/migrationLedgerPolicy.js";
import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";
import { readLocalReplicaMigrationIds } from "../tursoReplica/tursoReplicaMigrationConflict.js";
import {
  distBundleRevisionHash,
  PAPR_APP_CLOUD_REVISION_PATH,
} from "./cloudAppRevisionMarker.js";

/** Bounded main-thread wait for non-replica local files (better-sqlite3 default is 5000ms). */
const LOCAL_READ_BUSY_TIMEOUT_MS = 250;

export const PAPR_APP_META_RELATIVE_PATH = "__papr__/app-meta.json";

/** Git-tracked fields only — no updatedAt (avoids pointless writer churn). */
export interface CloudAppMetaRevision {
  schemaVersion: "1.0.0";
  distRevision: string;
  /** Highest executable migration id across linked DBs (excludes baseline markers). */
  requiredSchemaVersion: string | null;
}

export interface CloudAppMetaFile extends CloudAppMetaRevision {
  /** Mongo/API only — omitted from __papr__/app-meta.json on disk. */
  updatedAt?: string;
}

/**
 * Never open a replica-managed file with better-sqlite3 here: the turso sync worker
 * holds it, so a synchronous prepare blocks the gateway's main thread on SQLite's busy
 * timeout (observed 5.2s freeze during publish). Replica files are read through the
 * worker; plain local files keep a short-timeout read-only open.
 */
async function listAppliedMigrationIds(dbPath: string, dbId?: string): Promise<string[]> {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  if (isReplicaManagedDbPath(dbPath)) {
    return readLocalReplicaMigrationIds({
      id: dbId ?? dbPath,
      type: "sqlite",
      ...(dbId ? { dbId } : {}),
      alias: path.basename(path.dirname(dbPath)),
      dbPath,
      tables: [],
      linkedAt: new Date().toISOString(),
    });
  }
  const db = openDiagnosticDatabase(Database, "services/cloudSync/cloudAppMeta", dbPath, {
    readonly: true,
    timeout: LOCAL_READ_BUSY_TIMEOUT_MS,
  });
  try {
    return listAppliedMigrationIdsReadOnly(db);
  } finally {
    db.close();
  }
}

export function cloudAppMetaRevisionEqual(
  a: CloudAppMetaRevision,
  b: CloudAppMetaRevision,
): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.distRevision === b.distRevision &&
    a.requiredSchemaVersion === b.requiredSchemaVersion
  );
}

export function serializeCloudAppMetaForGit(revision: CloudAppMetaRevision): string {
  return `${JSON.stringify(revision, null, 2)}\n`;
}

export function parseCloudAppMetaRevision(raw: string): CloudAppMetaRevision | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CloudAppMetaFile>;
    if (parsed?.schemaVersion !== "1.0.0") {
      return null;
    }
    if (typeof parsed.distRevision !== "string") {
      return null;
    }
    return {
      schemaVersion: "1.0.0",
      distRevision: parsed.distRevision,
      requiredSchemaVersion: parsed.requiredSchemaVersion ?? null,
    };
  } catch {
    return null;
  }
}

export async function buildCloudAppMeta(
  appDir: string,
  appId: string,
  appsRootDir: string,
): Promise<CloudAppMetaRevision> {
  const distPath = path.join(appDir, "dist", "app.js");
  let distRevision: string;
  if (fs.existsSync(distPath)) {
    distRevision = distBundleRevisionHash(fs.readFileSync(distPath, "utf8"));
  } else if (fs.existsSync(path.join(appDir, PAPR_APP_CLOUD_REVISION_PATH))) {
    distRevision = fs
      .readFileSync(path.join(appDir, PAPR_APP_CLOUD_REVISION_PATH), "utf8")
      .trim()
      .split("\n")[0]
      ?.trim() ?? "0";
  } else {
    distRevision = "0";
  }

  const sources = (await discoverTursoLinkedSources(appsRootDir)).filter(
    (source) => source.appId === appId,
  );
  const migrationIds: string[] = [];
  const seenDbPaths = new Set<string>();
  for (const source of sources) {
    migrationIds.push(...(await listAppliedMigrationIds(source.dbPath, source.dbId)));
    seenDbPaths.add(path.normalize(source.dbPath));
  }

  for (const record of getDatabaseRegistryService().listBySchemaOwnerApp(appId)) {
    const normalized = path.normalize(record.localPath);
    if (seenDbPaths.has(normalized)) {
      continue;
    }
    migrationIds.push(...(await listAppliedMigrationIds(record.localPath, record.dbId)));
    seenDbPaths.add(normalized);
  }

  return {
    schemaVersion: "1.0.0",
    distRevision,
    requiredSchemaVersion: requiredSchemaVersionFromMigrationIds(migrationIds),
  };
}

export async function writeCloudAppMeta(
  paprDir: string,
  appId: string,
): Promise<CloudAppMetaFile> {
  const appDir = path.join(paprDir, "apps", appId);
  const revision = await buildCloudAppMeta(appDir, appId, path.join(paprDir, "apps"));
  const existing = readCloudAppMeta(appDir);
  if (existing) {
    const existingRevision = {
      schemaVersion: existing.schemaVersion,
      distRevision: existing.distRevision,
      requiredSchemaVersion: existing.requiredSchemaVersion,
    };
    if (cloudAppMetaRevisionEqual(existingRevision, revision)) {
      return existing;
    }
  }

  const metaDir = path.join(appDir, "__papr__");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, "app-meta.json"),
    serializeCloudAppMetaForGit(revision),
    "utf8",
  );

  const mongoMeta: CloudAppMetaFile = {
    ...revision,
    updatedAt: new Date().toISOString(),
  };

  void import("../syncV3/MetadataRegistryClient.js")
    .then(({ uploadAppRuntimeMetaToCloud }) =>
      uploadAppRuntimeMetaToCloud(appId, mongoMeta),
    )
    .catch(() => {});

  return mongoMeta;
}

export function readCloudAppMetaFromContent(raw: string): CloudAppMetaFile | null {
  return parseCloudAppMetaRevision(raw);
}

export function readCloudAppMeta(appDir: string): CloudAppMetaFile | null {
  const metaPath = path.join(appDir, PAPR_APP_META_RELATIVE_PATH);
  try {
    return readCloudAppMetaFromContent(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}
