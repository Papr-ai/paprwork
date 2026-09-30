import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  applyDatabaseMigrations,
  ensureSchemaMigrationsTable,
} from "../src/gateway/services/jobs/databaseMigrations.js";
import {
  detectSchemaMigrationsLayout,
  listAppliedMigrationIdsReadOnly,
  upgradeLegacySchemaMigrationsTable,
} from "../src/gateway/services/jobs/schemaMigrationsLedger.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("schemaMigrationsLedger", () => {
  test.skipIf(!canUseBetterSqlite)(
    "detects and upgrades legacy version-column ledger",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO schema_migrations (version) VALUES (1);
      `);

      expect(detectSchemaMigrationsLayout(db)).toBe("version");
      upgradeLegacySchemaMigrationsTable(db);
      expect(detectSchemaMigrationsLayout(db)).toBe("id");
      expect(listAppliedMigrationIdsReadOnly(db)).toContain("0001_baseline");
      db.close();
    },
  );

  test.skipIf(!canUseBetterSqlite)(
    "ensureSchemaMigrationsTable upgrades legacy layout before insert",
    async () => {
      const dbPath = ":memory:";
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT
        );
      `);
      db.close();

      const reopened = new Database(dbPath);
      expect(() => ensureSchemaMigrationsTable(reopened)).not.toThrow();
      expect(detectSchemaMigrationsLayout(reopened)).toBe("id");
      expect(listAppliedMigrationIdsReadOnly(reopened)).toContain("0001_baseline");
      reopened.close();
    },
  );

  test.skipIf(!canUseBetterSqlite)(
    "applyDatabaseMigrations works on legacy version-column ledger",
    async () => {
      const fs = await import("fs");
      const os = await import("os");
      const path = await import("path");

      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-legacy-mig-"));
      const migrationRoot = path.join(base, "job");
      const migrationsDir = path.join(migrationRoot, "migrations");
      const dbPath = path.join(migrationRoot, "data", "data.db");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT
        );
        CREATE TABLE briefs (id TEXT PRIMARY KEY, title TEXT);
      `);
      db.close();

      fs.writeFileSync(
        path.join(migrationsDir, "0002_add_summary.sql"),
        "ALTER TABLE briefs ADD COLUMN summary TEXT;",
      );

      const applied = await applyDatabaseMigrations(migrationRoot, dbPath);
      expect(applied).toEqual(["0002_add_summary.sql"]);

      const after = new Database(dbPath, { readonly: true });
      expect(detectSchemaMigrationsLayout(after)).toBe("id");
      expect(listAppliedMigrationIdsReadOnly(after)).toContain("0002_add_summary.sql");
      after.close();
    },
  );
});
