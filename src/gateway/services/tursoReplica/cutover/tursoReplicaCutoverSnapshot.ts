/**
 * Remote/local inspection for legacy → replica cutover classification.
 */

import * as fs from "fs";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import { tursoNameForRecord } from "../../DatabaseRegistryService.js";
import {
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
} from "../../tursoSyncBridgeCore.js";
import { ensureTursoSyncBridge } from "../../TursoSyncBridge.js";
import { localRemoteUserSchemaDriftTables } from "../../tursoDeltaSync.js";
import {
  isJobDbDirty,
  isJobDbQuarantined,
  loadTursoSyncState,
} from "../../tursoSyncState.js";
import {
  detectMigrationPushConflict,
  readRemoteTursoMigrationIds,
} from "../tursoReplicaMigrationConflict.js";
import { listLegacyCdcArtifactTablesForPath } from "../../legacyCdcArtifacts.js";
import type { CutoverSnapshot } from "./tursoReplicaCutoverTypes.js";

function countLocalSyncableTables(dbPath: string): number {
  if (!fs.existsSync(dbPath)) {
    return 0;
  }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      return 0;
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      return filterSyncableTables(listUserTables(db)).length;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function readLocalLegacyMigrationIds(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = listUserTables(db);
      if (!tables.includes("schema_migrations")) {
        return [];
      }
      const rows = db
        .prepare("SELECT id FROM schema_migrations ORDER BY id ASC")
        .all() as Array<{ id: string }>;
      return rows
        .map((row) => String(row.id ?? "").trim())
        .filter((id) => id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function countRemoteSyncableTables(
  tursoDatabase: string,
  dbPath: string,
): Promise<number> {
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return 0;
  }
  return bridge.runExclusiveForDbPath(dbPath, async () => {
    const credentials = await bridge.fetchCredentials(tursoDatabase);
    const remote = createClient({
      url: credentials.tursoUrl,
      authToken: credentials.authToken,
    });
    try {
      const result = await remote.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      );
      return filterSyncableTables(
        result.rows.map((row) => String(row.name ?? "")),
      ).length;
    } finally {
      remote.close();
    }
  });
}

async function detectRemoteSchemaDrift(
  dbPath: string,
  tursoDatabase: string,
): Promise<boolean> {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return false;
  }
  return bridge.runExclusiveForDbPath(dbPath, async () => {
    let credentials;
    try {
      credentials = await bridge.fetchCredentials(tursoDatabase);
    } catch {
      return false;
    }
    const remote = createClient({
      url: credentials.tursoUrl,
      authToken: credentials.authToken,
    });
    const localDb = openWritableLocalJobDb(dbPath);
    try {
      const tableNames = filterSyncableTables(listUserTables(localDb));
      if (tableNames.length === 0) {
        return false;
      }
      const drifted = await localRemoteUserSchemaDriftTables(
        remote,
        localDb,
        tableNames,
      );
      return drifted.length > 0;
    } finally {
      localDb.close();
      remote.close();
    }
  });
}

/** Gather local/remote state for one registry database still on legacy sync. */
export async function snapshotLegacyRecordForCutover(
  record: DatabaseRecord,
): Promise<CutoverSnapshot> {
  const dbPath = record.localPath;
  const dbExists = fs.existsSync(dbPath);
  const localTableCount = countLocalSyncableTables(dbPath);
  const tursoDatabase = tursoNameForRecord(record);
  const pushState = loadTursoSyncState();
  const syncKey = record.dbId;
  const alternateKeys = record.ownerJobId ? [record.ownerJobId] : [];
  const quarantined =
    isJobDbQuarantined(syncKey, pushState) ||
    alternateKeys.some((key) => isJobDbQuarantined(key, pushState));
  const dirty = isJobDbDirty(syncKey, dbPath, pushState, alternateKeys);
  const legacyArtifactTables = listLegacyCdcArtifactTablesForPath(dbPath);

  let remoteTableCount = 0;
  let schemaDrift = false;
  let remoteCheckFailed = false;
  try {
    remoteTableCount = await countRemoteSyncableTables(tursoDatabase, dbPath);
    if (remoteTableCount > 0 && localTableCount > 0) {
      schemaDrift = await detectRemoteSchemaDrift(dbPath, tursoDatabase);
    }
  } catch {
    remoteCheckFailed = true;
  }

  let localMigrationIds = readLocalLegacyMigrationIds(dbPath);
  let remoteMigrationIds: string[] = [];
  try {
    remoteMigrationIds = await readRemoteTursoMigrationIds(tursoDatabase);
  } catch {
    remoteCheckFailed = true;
  }
  const migrationConflictResult = detectMigrationPushConflict(
    localMigrationIds,
    remoteMigrationIds,
  );

  return {
    dbExists,
    localTableCount,
    remoteTableCount,
    schemaDrift,
    legacyArtifactTables,
    remoteCheckFailed,
    dirty,
    quarantined,
    localMigrationIds,
    remoteMigrationIds,
    migrationConflict: migrationConflictResult !== null,
    migrationConflictReason: migrationConflictResult?.message,
  };
}
