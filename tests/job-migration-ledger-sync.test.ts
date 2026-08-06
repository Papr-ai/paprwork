import { describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  alignMigrationLedgers,
  hydrateLocalSchemaMigrationsFromRemote,
  reconcileRemoteMigrationLedger,
} from "../src/gateway/services/jobs/jobMigrationLedgerSync.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

function createMockRemote(
  initialColumns: Record<string, string[]>,
  appliedMigrations: string[] = [],
): Client {
  const columnsByTable = new Map<string, Set<string>>(
    Object.entries(initialColumns).map(([table, cols]) => [table, new Set(cols)]),
  );
  const remoteLedger = new Set(appliedMigrations);

  return {
    execute: vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === "string" ? input : input.sql;
      const args = typeof input === "string" ? [] : (input.args ?? []);

      if (sql.includes("CREATE TABLE IF NOT EXISTS _papr_schema_migrations")) {
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      if (sql.startsWith("SELECT id FROM _papr_schema_migrations")) {
        return {
          rows: [...remoteLedger].map((id) => ({ id })),
          columns: ["id"],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("SELECT id, applied_at FROM _papr_schema_migrations")) {
        return {
          rows: [...remoteLedger].map((id) => ({
            id,
            applied_at: "2026-01-01T00:00:00.000Z",
          })),
          columns: ["id", "applied_at"],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("INSERT OR IGNORE INTO _papr_schema_migrations")) {
        remoteLedger.add(String(args[0]));
        return { rows: [], columns: [], rowsAffected: 1 };
      }
      if (sql.startsWith("PRAGMA table_info(")) {
        const table = sql.match(/PRAGMA table_info\("([^"]+)"\)/)?.[1];
        const cols = table ? columnsByTable.get(table) : undefined;
        return {
          rows: [...(cols ?? [])].map((name) => ({ name, type: "TEXT", pk: 0 })),
          columns: ["name", "type", "pk"],
          rowsAffected: 0,
        };
      }
      if (sql.includes("sqlite_master")) {
        const table = String(args[0] ?? "");
        const cols = columnsByTable.get(table);
        return {
          rows: cols ? [{ 1: 1 }] : [],
          columns: ["1"],
          rowsAffected: 0,
        };
      }
      throw new Error(`Unexpected SQL in mock remote: ${sql}`);
    }),
    close: vi.fn(),
  } as unknown as Client;
}

describe("jobMigrationLedgerSync", () => {
  it.skipIf(!canUseBetterSqlite)(
    "backfills remote ledger when columns already exist",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-ledger-"));
      const migrationRoot = path.join(base, "registry");
      const dbPath = path.join(migrationRoot, "data.db");
      fs.mkdirSync(path.join(migrationRoot, "migrations"), { recursive: true });
      fs.writeFileSync(
        path.join(migrationRoot, "migrations", "0002_add_contact_fields.sql"),
        "ALTER TABLE audits ADD COLUMN contact_name TEXT;\nALTER TABLE audits ADD COLUMN contact_email TEXT;",
      );

      const localDb = new Database(dbPath);
      localDb.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
        CREATE TABLE audits (id TEXT PRIMARY KEY, company_name TEXT NOT NULL);
      `);
      localDb.close();

      const remote = createMockRemote({
        audits: ["id", "company_name", "contact_name", "contact_email"],
      });

      const backfilled = await reconcileRemoteMigrationLedger(remote, migrationRoot);
      expect(backfilled).toEqual(["0002_add_contact_fields.sql"]);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "hydrates local ledger from remote after pull",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-hydrate-"));
      const dbPath = path.join(base, "data.db");
      const localDb = new Database(dbPath);
      localDb.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
        CREATE TABLE audits (id TEXT PRIMARY KEY, company_name TEXT, contact_name TEXT);
      `);
      localDb.close();

      const remote = createMockRemote(
        { audits: ["id", "company_name", "contact_name"] },
        ["0002_add_contact_fields.sql"],
      );

      const hydrated = await hydrateLocalSchemaMigrationsFromRemote(remote, dbPath);
      expect(hydrated).toEqual(["0002_add_contact_fields.sql"]);

      const after = new Database(dbPath, { readonly: true });
      const row = after
        .prepare("SELECT id FROM schema_migrations WHERE id = ?")
        .get("0002_add_contact_fields.sql") as { id: string } | undefined;
      after.close();
      expect(row?.id).toBe("0002_add_contact_fields.sql");
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "alignMigrationLedgers fixes sandbox split-brain (schema ahead of ledger)",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-align-"));
      const migrationRoot = path.join(base, "registry");
      const dbPath = path.join(migrationRoot, "data.db");
      fs.mkdirSync(path.join(migrationRoot, "migrations"), { recursive: true });
      fs.writeFileSync(
        path.join(migrationRoot, "migrations", "0002_add_contact_fields.sql"),
        "ALTER TABLE audits ADD COLUMN contact_name TEXT;\nALTER TABLE audits ADD COLUMN contact_email TEXT;",
      );

      const localDb = new Database(dbPath);
      localDb.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
        CREATE TABLE audits (
          id TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          contact_name TEXT,
          contact_email TEXT
        );
      `);
      localDb.close();

      const remote = createMockRemote({
        audits: ["id", "company_name", "contact_name", "contact_email"],
      });

      const result = await alignMigrationLedgers(remote, dbPath, migrationRoot);
      expect(result.remoteBackfilled).toEqual(["0002_add_contact_fields.sql"]);
      expect(result.localHydrated).toEqual(["0002_add_contact_fields.sql"]);
      expect(result.localInferred).toEqual([]);
    },
  );
});
