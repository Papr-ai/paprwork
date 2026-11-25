/**
 * Give every active registry database a local file path on this machine.
 *
 * databases.json syncs through the cloud with `localPath` stripped (a Mac path means
 * nothing on another machine). A database that arrives that way is adopted with
 * `localPath: ""`, and nothing else can fill it in: the other repairs rebuild a path
 * from a stored path, a file on disk or an old path's folder, and a brand-new arrival
 * has none of those. The replica then opened "" — the process's working directory —
 * re-downloading into the code folder until the daily budget parked sync.
 *
 * The local path is purely this machine's choice, so assign it here, from the record
 * itself: `data/databases/{slug(label)}/data.db`. Never touches a record that already
 * has a path. Never reuses a folder that another record owns or that already holds a
 * file (an unknown leftover is not assumed to be this database) — those get the short
 * dbId appended. The new file does not exist yet, so the first open is one normal
 * fresh download from the cloud.
 */

import * as fs from "fs";
import * as path from "path";
import { slugifyDatabaseAlias } from "./appDataSources.js";

interface AssignableRecord {
  dbId: string;
  localPath: string;
  label?: string;
  status?: string;
}

function norm(p: string): string {
  return path.normalize(p);
}

function folderSlug(record: AssignableRecord): string {
  const fromLabel = record.label?.trim() ? slugifyDatabaseAlias(record.label) : "";
  return fromLabel || slugifyDatabaseAlias(record.dbId) || "database";
}

/**
 * Assigns a path to each active record whose localPath is blank. Mutates the
 * records in place and returns the dbIds it changed.
 */
export function assignMissingLocalPaths(
  databases: Record<string, AssignableRecord>,
  dataDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  // Cloud app host / sandboxes have no local Papr tree and resolve by dbId only:
  // assigning a path there would invent files nobody uses. Desktop only.
  if (!exists(dataDir)) {
    return [];
  }
  const taken = new Set(
    Object.values(databases)
      .map((r) => r?.localPath?.trim() ?? "")
      .filter(Boolean)
      .map(norm),
  );
  const changed: string[] = [];
  for (const record of Object.values(databases)) {
    if (!record || record.status !== "active" || record.localPath?.trim()) {
      continue;
    }
    const base = folderSlug(record);
    const short = slugifyDatabaseAlias(record.dbId.replace(/^db-/, "")).slice(0, 8) || "x";
    const candidates = [base, `${base}-${short}`, `${base}-${slugifyDatabaseAlias(record.dbId)}`];
    const chosen = candidates
      .map((slug) => norm(path.join(dataDir, "databases", slug, "data.db")))
      .find((p) => !taken.has(p) && !exists(p));
    if (!chosen) {
      continue;
    }
    record.localPath = chosen;
    taken.add(chosen);
    changed.push(record.dbId);
  }
  return changed;
}
