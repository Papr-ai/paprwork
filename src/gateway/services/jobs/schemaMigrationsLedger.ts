/**
 * Local schema_migrations ledger — supports modern (id) and legacy (version) layouts.
 */

import Database from "better-sqlite3";
import { quoteIdent } from "../tursoSyncBridgeCore.js";

export type SchemaMigrationsLayout = "id" | "version" | "missing";

const TABLE = "schema_migrations";
const LEGACY_BACKUP = "schema_migrations_legacy_version";

export function detectSchemaMigrationsLayout(
  db: Database.Database,
): SchemaMigrationsLayout {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(TABLE) as { 1: number } | undefined;
  if (!exists) {
    return "missing";
  }

  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdent(TABLE)})`)
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((col) => col.name));
  if (names.has("id")) {
    return "id";
  }
  if (names.has("version")) {
    return "version";
  }
  return "missing";
}

function legacyVersionToMigrationId(version: number | string): string {
  const normalized = String(version).trim();
  if (normalized === "1" || normalized === "0001") {
    return "0001_baseline";
  }
  return `legacy_version_${normalized}`;
}

/** Upgrade legacy INTEGER version column table to id TEXT ledger (in-place). */
export function upgradeLegacySchemaMigrationsTable(db: Database.Database): void {
  if (detectSchemaMigrationsLayout(db) !== "version") {
    return;
  }

  db.exec(`ALTER TABLE ${quoteIdent(TABLE)} RENAME TO ${quoteIdent(LEGACY_BACKUP)}`);
  db.exec(`
    CREATE TABLE ${quoteIdent(TABLE)} (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdent(TABLE)} (id, applied_at) VALUES (?, ?)`,
  );

  try {
    const legacyRows = db
      .prepare(
        `SELECT version, applied_at FROM ${quoteIdent(LEGACY_BACKUP)} ORDER BY version`,
      )
      .all() as Array<{ version: number | string; applied_at: string | null }>;

    for (const row of legacyRows) {
      insert.run(
        legacyVersionToMigrationId(row.version),
        row.applied_at ?? new Date().toISOString(),
      );
    }
  } catch {
    /* legacy table unreadable — fresh ledger below */
  }

  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(LEGACY_BACKUP)}`);
}

export function ensureSchemaMigrationsTable(db: Database.Database): void {
  const layout = detectSchemaMigrationsLayout(db);
  if (layout === "missing") {
    db.exec(`
      CREATE TABLE ${quoteIdent(TABLE)} (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  } else if (layout === "version") {
    upgradeLegacySchemaMigrationsTable(db);
  }

  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdent(TABLE)} (id, applied_at) VALUES (?, ?)`,
  ).run("0001_baseline", new Date().toISOString());
}

/** Read applied migration ids without mutating the database. */
export function listAppliedMigrationIdsReadOnly(db: Database.Database): string[] {
  const layout = detectSchemaMigrationsLayout(db);
  if (layout === "id") {
    try {
      const rows = db
        .prepare(`SELECT id FROM ${quoteIdent(TABLE)} ORDER BY id`)
        .all() as Array<{ id: string }>;
      return rows.map((row) => row.id).filter((id) => id.length > 0);
    } catch {
      return [];
    }
  }

  if (layout === "version") {
    try {
      const rows = db
        .prepare(`SELECT version FROM ${quoteIdent(TABLE)} ORDER BY version`)
        .all() as Array<{ version: number | string }>;
      return rows
        .map((row) => legacyVersionToMigrationId(row.version))
        .filter((id) => id.length > 0);
    } catch {
      return [];
    }
  }

  return [];
}

/** Ensure modern ledger then return applied migration ids. */
export function listAppliedMigrationIds(db: Database.Database): string[] {
  ensureSchemaMigrationsTable(db);
  return listAppliedMigrationIdsReadOnly(db);
}
