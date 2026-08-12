/**
 * Reads `app_files` rows for publish-time asset resolution.
 *
 * An app may link several databases, and `app_files` lives in whichever ones
 * the app actually writes files to. Rather than assume a location, this scans
 * the linked sources and reads the table wherever it exists — a missing table
 * is the normal case for an app that has never uploaded a file, not an error.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import * as path from "path";
import * as fs from "fs";
import type { AppFileRow } from "./appFilesSchema.js";
import {
  parseDataSourcesFile,
  resolveDataSourcesForWorkspace,
} from "../appDataSources.js";

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

/**
 * Every `app_files` row belonging to this app, across all linked databases.
 *
 * Read-only and defensive: publishing must not be the thing that discovers a
 * corrupt database, so unreadable sources are skipped rather than thrown.
 */
export function readAppFileRows(
  paprDir: string,
  appId: string,
): AppFileRow[] {
  const rows: AppFileRow[] = [];

  for (const dbPath of linkedDbPathsForApp(paprDir, appId)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const hasTable = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='app_files'`,
        )
        .get();
      if (!hasTable) continue;

      const found = db
        .prepare(`SELECT * FROM app_files WHERE app_id = ?`)
        .all(appId) as AppFileRow[];
      rows.push(...found);
    } catch {
      /* unreadable source — skip */
    } finally {
      db?.close();
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
