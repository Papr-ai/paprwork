/**
 * Per-app cloud metadata — dist revision + required Turso schema version.
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { discoverTursoLinkedSources } from "../tursoLinkedSources.js";
import { listAppliedMigrationIdsReadOnly } from "../jobs/schemaMigrationsLedger.js";
import { requiredSchemaVersionFromMigrationIds } from "../jobs/migrationLedgerPolicy.js";
import {
  distBundleRevisionHash,
  PAPR_APP_CLOUD_REVISION_PATH,
} from "./cloudAppRevisionMarker.js";

export const PAPR_APP_META_RELATIVE_PATH = "__papr__/app-meta.json";

export interface CloudAppMetaFile {
  schemaVersion: "1.0.0";
  distRevision: string;
  /** Highest executable migration id across linked DBs (excludes baseline markers). */
  requiredSchemaVersion: string | null;
  updatedAt: string;
}

function listAppliedMigrationIds(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return listAppliedMigrationIdsReadOnly(db);
  } finally {
    db.close();
  }
}

export async function buildCloudAppMeta(
  appDir: string,
  appId: string,
  appsRootDir: string,
): Promise<CloudAppMetaFile> {
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
  for (const source of sources) {
    migrationIds.push(...listAppliedMigrationIds(source.dbPath));
  }

  return {
    schemaVersion: "1.0.0",
    distRevision,
    requiredSchemaVersion: requiredSchemaVersionFromMigrationIds(migrationIds),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeCloudAppMeta(
  paprDir: string,
  appId: string,
): Promise<CloudAppMetaFile> {
  const appDir = path.join(paprDir, "apps", appId);
  const meta = await buildCloudAppMeta(appDir, appId, path.join(paprDir, "apps"));
  const metaDir = path.join(appDir, "__papr__");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, "app-meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return meta;
}

export function readCloudAppMetaFromContent(raw: string): CloudAppMetaFile | null {
  try {
    const parsed = JSON.parse(raw) as CloudAppMetaFile;
    if (parsed?.schemaVersion === "1.0.0") {
      return parsed;
    }
  } catch {
    /* invalid */
  }
  return null;
}

export function readCloudAppMeta(appDir: string): CloudAppMetaFile | null {
  const metaPath = path.join(appDir, PAPR_APP_META_RELATIVE_PATH);
  try {
    return readCloudAppMetaFromContent(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}
