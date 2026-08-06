import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyDatabaseMigrations,
  resolveMigrationRootFromDbPath,
  resolvePersistedDatabaseLayout,
} from "../src/gateway/services/jobs/databaseMigrations.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("databaseMigrations", () => {
  test("resolves registry and job migration roots", () => {
    expect(
      resolveMigrationRootFromDbPath(
        "/Users/test/Papr/data/databases/gtm-audit/data.db",
      ),
    ).toBe("/Users/test/Papr/data/databases/gtm-audit");

    expect(
      resolveMigrationRootFromDbPath(
        "/Users/test/Papr/Jobs/job-1/data/data.db",
      ),
    ).toBe("/Users/test/Papr/Jobs/job-1");

    expect(resolveMigrationRootFromDbPath("/tmp/foo.db")).toBeNull();
  });

  test("classifies registry vs job layout", () => {
    const registry = resolvePersistedDatabaseLayout(
      "/Users/test/Papr/data/databases/billing/data.db",
    );
    expect(registry?.kind).toBe("registry");

    const job = resolvePersistedDatabaseLayout(
      "/Users/test/Papr/Jobs/job-1/data/data.db",
    );
    expect(job?.kind).toBe("job");
  });

  test.skipIf(!canUseBetterSqlite)(
    "applies migration idempotently when columns already exist (Turso pull drift)",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-local-mig-"));
      const migrationRoot = path.join(base, "registry");
      const migrationsDir = path.join(migrationRoot, "migrations");
      const dbPath = path.join(migrationRoot, "data.db");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationsDir, "0002_add_contact_fields.sql"),
        "ALTER TABLE audits ADD COLUMN contact_name TEXT;\nALTER TABLE audits ADD COLUMN contact_email TEXT;",
      );

      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
        CREATE TABLE audits (
          id TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          contact_name TEXT,
          contact_email TEXT
        );
      `);
      db.close();

      const applied = await applyDatabaseMigrations(migrationRoot, dbPath);
      expect(applied).toEqual(["0002_add_contact_fields.sql"]);

      const after = new Database(dbPath, { readonly: true });
      const migrationIds = after
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;
      after.close();

      expect(migrationIds.map((row) => row.id)).toContain(
        "0002_add_contact_fields.sql",
      );
    },
  );
});
