/**
 * Content fingerprints for Turso sync — skip unchanged tables and detect real edits.
 */

import { createHash } from "crypto";
import Database from "better-sqlite3";
import {
  filterSyncableTables,
  listUserTables,
  quoteIdent,
  readTableSchema,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";

const FINGERPRINT_VERSION = "v2";
const ROW_BATCH_SIZE = 1_000;

function schemaSignature(columns: TableColumn[]): string {
  return columns
    .map((col) => `${col.name}:${col.type}:${col.primaryKey ? 1 : 0}`)
    .join(",");
}

export function computeTableFingerprint(
  db: Database.Database,
  tableName: string,
): string {
  const columns = readTableSchema(db, tableName);
  const schemaSig = schemaSignature(columns);
  const quoted = quoteIdent(tableName);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
    .get() as { count: number };
  const rowCount = countRow.count ?? 0;

  if (columns.length === 0) {
    return `${FINGERPRINT_VERSION}|empty-schema|0`;
  }

  if (rowCount === 0) {
    return `${FINGERPRINT_VERSION}|${schemaSig}|0`;
  }

  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_VERSION}|${schemaSig}|${rowCount}|`);

  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  let offset = 0;
  while (offset < rowCount) {
    const batch = db
      .prepare(
        `SELECT ${colList} FROM ${quoted} ORDER BY rowid LIMIT ? OFFSET ?`,
      )
      .raw()
      .all(ROW_BATCH_SIZE, offset) as unknown[][];
    for (const row of batch) {
      hash.update(JSON.stringify(row));
    }
    offset += ROW_BATCH_SIZE;
  }

  return hash.digest("hex").slice(0, 24);
}

export function computeSyncableTableFingerprints(
  db: Database.Database,
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const tableName of filterSyncableTables(listUserTables(db))) {
    fingerprints[tableName] = computeTableFingerprint(db, tableName);
  }
  return fingerprints;
}

export function computeSyncableTableFingerprintsForPath(
  dbPath: string,
): Record<string, string> | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return computeSyncableTableFingerprints(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function fingerprintsEqual(
  current: Record<string, string>,
  previous: Record<string, string> | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  const currentKeys = Object.keys(current).sort();
  const previousKeys = Object.keys(previous).sort();
  if (currentKeys.length !== previousKeys.length) {
    return false;
  }
  for (let i = 0; i < currentKeys.length; i += 1) {
    if (currentKeys[i] !== previousKeys[i]) {
      return false;
    }
    if (current[currentKeys[i]!] !== previous[previousKeys[i]!]) {
      return false;
    }
  }
  return true;
}

export function schemasMatch(
  left: TableColumn[],
  right: TableColumn[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return schemaSignature(left) === schemaSignature(right);
}
