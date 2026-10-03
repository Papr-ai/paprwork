/**
 * Reads `app_files` rows for publish-time asset resolution.
 *
 * An app may link several databases, and `app_files` lives in whichever ones
 * the app actually writes files to. Rather than assume a location, this scans
 * the linked sources and reads the table wherever it exists — a missing table
 * is the normal case for an app that has never uploaded a file, not an error.
 */

import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";

import Database from "better-sqlite3";
import { existsSync } from "fs";
import * as path from "path";
import * as fs from "fs";
import type { AppFileRow } from "./appFilesSchema.js";
import {
  parseDataSourcesFile,
  resolveDataSourcesForWorkspace,
} from "../appDataSources.js";
import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";
import { queryLinkedDbViaTursoReplica } from "../tursoReplica/tursoReplicaRouting.js";

/** Absolute paths of every SQLite file linked to an app. */
export function linkedDbPathsForApp(paprDir: string, appId: string): string[] {
  const file = path.join(paprDir, "apps", appId, "data-sources.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = parseDataSourcesFile(fs.readFileSync(file, "utf-8"));
    const resolved = resolveDataSourcesForWorkspace(
      parsed,
      path.join(paprDir, "Jobs"),
    );
    return resolved.sources
      .map((source) => source.dbPath)
      .filter((dbPath) => Boolean(dbPath) && existsSync(dbPath));
  } catch {
    // A malformed data-sources.json is a separate problem with its own error
    // path; it must not turn into a confusing publish failure here.
    return [];
  }
}

const APP_FILES_TABLE_SQL = `SELECT name FROM sqlite_master WHERE type='table' AND name='app_files'`;
const APP_FILES_ROWS_SQL = `SELECT * FROM app_files WHERE app_id = ?`;
/** Bounded main-thread wait for non-replica files (better-sqlite3 default is 5000ms). */
const LOCAL_READ_BUSY_TIMEOUT_MS = 250;

/**
 * Replica-managed files are held by the turso sync worker; a better-sqlite3 open on
 * the gateway main thread blocks on SQLite's busy timeout and freezes the gateway.
 * Read those through the worker; open plain local files with a short timeout.
 */
async function readAppFileRowsFromDb(dbPath: string, appId: string): Promise<AppFileRow[]> {
  if (isReplicaManagedDbPath(dbPath)) {
    const source = {
      id: dbPath, type: "sqlite" as const, alias: path.basename(path.dirname(dbPath)),
      dbPath, tables: [], linkedAt: new Date().toISOString(),
    };
    const table = await queryLinkedDbViaTursoReplica(source, APP_FILES_TABLE_SQL, [], { pullBeforeRead: false });
    if (table.rows.length === 0) return [];
    const found = await queryLinkedDbViaTursoReplica(source, APP_FILES_ROWS_SQL, [appId], { pullBeforeRead: false });
    return found.rows as unknown as AppFileRow[];
  }
  const db = openDiagnosticDatabase(Database, "services/appFiles/publishAssetReader", dbPath, {
    readonly: true, fileMustExist: true, timeout: LOCAL_READ_BUSY_TIMEOUT_MS,
  });
  try {
    if (!db.prepare(APP_FILES_TABLE_SQL).get()) return [];
    return db.prepare(APP_FILES_ROWS_SQL).all(appId) as AppFileRow[];
  } finally {
    db.close();
  }
}

/**
 * Every `app_files` row belonging to this app, across all linked databases.
 *
 * Read-only and defensive: publishing must not be the thing that discovers a
 * corrupt database, so unreadable sources are skipped rather than thrown.
 */
export async function readAppFileRows(
  paprDir: string,
  appId: string,
): Promise<AppFileRow[]> {
  const rows: AppFileRow[] = [];

  for (const dbPath of linkedDbPathsForApp(paprDir, appId)) {
    try {
      rows.push(...(await readAppFileRowsFromDb(dbPath, appId)));
    } catch {
      /* unreadable source — skip */
    }
  }

  // The same object can be linked from more than one database; flipping its
  // visibility twice is harmless but reporting it twice is misleading.
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.object_key)) return false;
    seen.add(row.object_key);
    return true;
  });
}
