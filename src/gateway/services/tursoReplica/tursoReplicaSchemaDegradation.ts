/**
 * Refuse to settle a re-bootstrap onto a schema that is worse than the one we had.
 *
 * Regression: a cloud job runner rewrote every remote table as `"col" TEXT, ...` (no PRIMARY
 * KEY, no AUTOINCREMENT, no types). After an engine panic the replica re-bootstrapped from
 * that copy, the marker cleared, and the app went blank — `"0"` is truthy, `1 != '1'`, and new
 * rows got NULL ids. Replaying the snapshot onto such a table is worse still: `INSERT OR
 * REPLACE` without a key appends, so every preserved row would be duplicated.
 *
 * The pre-repair snapshot is the only remaining copy of the correct schema, so when the
 * bootstrapped schema has lost keys or types relative to it, the bootstrap must not be
 * treated as successful and the snapshot must not be deleted.
 */

import type Database from "better-sqlite3";
import { isReplicaUserDataTable } from "./tursoReplicaBootstrapMarker.js";

export interface SchemaDegradation {
  table: string;
  /** Primary-key columns in the snapshot that are no longer keys. */
  lostPrimaryKey: string[];
  /** Columns whose declared type became TEXT/untyped (e.g. INTEGER -> TEXT). */
  lostTypes: string[];
}

interface ColInfo {
  name: string;
  type: string;
  pk: number;
}

const TEXTUAL = new Set(["", "TEXT"]);

function normType(type: string | null | undefined): string {
  return String(type ?? "").trim().toUpperCase();
}

function tableInfo(db: Database.Database, schema: "main" | string, table: string): ColInfo[] {
  return db
    .prepare(`PRAGMA ${schema}.table_info("${table.replace(/"/g, '""')}")`)
    .all() as ColInfo[];
}

/**
 * Compare live (`main`) tables against an attached snapshot schema.
 * Only tables present in both are compared; missing tables are a migration concern.
 */
export function detectSchemaDegradation(
  db: Database.Database,
  snapshotSchema: string,
): SchemaDegradation[] {
  const snapTables = (
    db
      .prepare(
        `SELECT name FROM ${snapshotSchema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>
  )
    .map((r) => r.name)
    .filter(isReplicaUserDataTable)
    .filter((name) => !name.startsWith("_papr_") && !name.startsWith("__turso_internal"));

  const out: SchemaDegradation[] = [];
  for (const table of snapTables) {
    const live = tableInfo(db, "main", table);
    if (live.length === 0) {
      continue;
    }
    const liveByName = new Map(live.map((c) => [c.name, c]));
    const snap = tableInfo(db, snapshotSchema, table);
    const lostPrimaryKey = snap
      .filter((c) => c.pk > 0 && (liveByName.get(c.name)?.pk ?? 0) === 0)
      .filter((c) => liveByName.has(c.name))
      .map((c) => c.name);
    const lostTypes = snap
      .filter((c) => {
        const l = liveByName.get(c.name);
        return l && !TEXTUAL.has(normType(c.type)) && TEXTUAL.has(normType(l.type));
      })
      .map((c) => c.name);
    if (lostPrimaryKey.length > 0 || lostTypes.length > 0) {
      out.push({ table, lostPrimaryKey, lostTypes });
    }
  }
  return out;
}

export function describeSchemaDegradation(found: readonly SchemaDegradation[]): string {
  const parts = found.slice(0, 5).map((d) => {
    const bits = [
      d.lostPrimaryKey.length ? `lost PRIMARY KEY (${d.lostPrimaryKey.join(", ")})` : "",
      d.lostTypes.length ? `lost types (${d.lostTypes.slice(0, 4).join(", ")})` : "",
    ].filter(Boolean);
    return `${d.table}: ${bits.join("; ")}`;
  });
  const more = found.length > 5 ? ` (+${found.length - 5} more)` : "";
  return (
    "Cloud copy has a degraded schema compared to the pre-repair snapshot — refusing to " +
    `adopt it and keeping the snapshot. ${parts.join(" | ")}${more}`
  );
}
