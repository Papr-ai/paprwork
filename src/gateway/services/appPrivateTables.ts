/**
 * Private tables for one local app: union of `privateTables` on every registry
 * database linked in the app's data-sources.json. Used by validate_app and the
 * cloud publish preflight so both see the same set the cloud host enforces.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { parseDataSourcesFile } from "./appDataSources.js";
import { getDatabaseRegistryService, privateTablesOf } from "./DatabaseRegistryService.js";

export interface AppPrivateTables {
  /** Union across linked DBs (lower-case). */
  tables: Set<string>;
  /** dbId → private tables on that DB. */
  byDb: Map<string, Set<string>>;
}

export async function resolveAppPrivateTables(appPath: string): Promise<AppPrivateTables> {
  const tables = new Set<string>();
  const byDb = new Map<string, Set<string>>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(appPath, "data-sources.json"), "utf8");
  } catch {
    return { tables, byDb };
  }
  const registry = getDatabaseRegistryService();
  for (const source of parseDataSourcesFile(raw).sources) {
    const record = registry.getRecordForSource(source);
    const set = privateTablesOf(record);
    if (set.size === 0 || !record) continue;
    byDb.set(record.dbId, set);
    for (const t of set) tables.add(t);
  }
  return { tables, byDb };
}
