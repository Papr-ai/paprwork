import { describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyPendingDatabaseMigrationsToTurso } from "../src/gateway/services/jobs/jobMigrationTursoSync.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

function createMockRemote(initialColumns: Record<string, string[]>): Client {
  const columnsByTable = new Map<string, Set<string>>(
    Object.entries(initialColumns).map(([table, cols]) => [table, new Set(cols)]),
  );
  const appliedMigrations = new Set<string>();

  return {
    execute: vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === "string" ? input : input.sql;
      const args = typeof input === "string" ? [] : (input.args ?? []);

      if (sql.includes("CREATE TABLE IF NOT EXISTS _papr_schema_migrations")) {
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      if (sql.includes("FROM sqlite_master") && sql.includes("type='table'")) {
        return {
          rows: [...columnsByTable.keys()].map((name) => ({ name })),
          columns: ["name"],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("SELECT id FROM _papr_schema_migrations")) {
        return {
          rows: [...appliedMigrations].map((id) => ({ id })),
          columns: ["id"],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("INSERT OR IGNORE INTO _papr_schema_migrations")) {
        appliedMigrations.add(String(args[0]));
        return { rows: [], columns: [], rowsAffected: 1 };
      }
      if (sql.startsWith("PRAGMA table_info(")) {
        const table = sql.match(/PRAGMA table_info\("([^"]+)"\)/)?.[1];
        const cols = table ? columnsByTable.get(table) : undefined;
        return {
          rows: [...(cols ?? [])].map((name) => ({
            name,
            type: "TEXT",
            pk: 0,
          })),
          columns: ["name", "type", "pk"],
          rowsAffected: 0,
        };
      }
      const createTableMatch =
        /^CREATE TABLE IF NOT EXISTS "([^"]+)" \((.+)\)$/i.exec(sql.trim());
      if (createTableMatch) {
        const table = createTableMatch[1]!;
        if (!columnsByTable.has(table)) {
          columnsByTable.set(table, new Set(["id"]));
        }
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      if (/^CREATE INDEX IF NOT EXISTS/i.test(sql.trim())) {
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      const addMatch =
        /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (.+)$/i.exec(sql.trim());
      if (addMatch) {
        const [, table, column] = addMatch;
        const cols = columnsByTable.get(table!) ?? new Set<string>();
        if (cols.has(column!)) {
          throw new Error(`SQLITE_UNKNOWN: duplicate column name: ${column}`);
        }
        cols.add(column!);
        columnsByTable.set(table!, cols);
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      throw new Error(`Unexpected SQL in mock remote: ${sql}`);
    }),
    close: vi.fn(),
  } as unknown as Client;
}

describe("jobMigrationTursoSync", () => {
  it.skipIf(!canUseBetterSqlite)(
    "skips ADD COLUMN on Turso when column already exists (drift sync)",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-turso-"));
      const migrationRoot = path.join(base, "registry");
      const migrationsDir = path.join(migrationRoot, "migrations");
      const dbPath = path.join(migrationRoot, "data.db");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationsDir, "0002_add_contact_fields.sql"),
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

      const applied = await applyPendingDatabaseMigrationsToTurso(
        remote,
        dbPath,
        migrationRoot,
      );

      expect(applied).toEqual(["0002_add_contact_fields.sql"]);
      expect(remote.execute).toHaveBeenCalled();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "applies CREATE INDEX migration when table already exists on remote",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-turso-"));
      const migrationRoot = path.join(base, "registry");
      const migrationsDir = path.join(migrationRoot, "migrations");
      const dbPath = path.join(migrationRoot, "data.db");
      fs.mkdirSync(migrationsDir, { recursive: true });
      fs.writeFileSync(
        path.join(migrationsDir, "0002_social.sql"),
        `CREATE TABLE IF NOT EXISTS social_posts (post_id TEXT PRIMARY KEY, shop_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_shop ON social_posts(shop_id);`,
      );

      const localDb = new Database(dbPath);
      localDb.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
      CREATE TABLE social_posts (post_id TEXT PRIMARY KEY, shop_id TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0002_social.sql', datetime('now'));
    `);
      localDb.close();

      const remote = createMockRemote({
        social_posts: ["post_id", "shop_id"],
      });

      const applied = await applyPendingDatabaseMigrationsToTurso(
        remote,
        dbPath,
        migrationRoot,
      );

      expect(applied).toEqual(["0002_social.sql"]);
    },
  );

  it("localMissingRemoteTables detects tables present on remote but not local", async () => {
    const { localMissingRemoteTables } = await import(
      "../src/gateway/services/tursoDeltaSync.js"
    );
    const remote = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("sqlite_master")) {
          return {
            rows: [{ name: "audits" }, { name: "audit_modules" }],
            columns: ["name"],
            rowsAffected: 0,
          };
        }
        return { rows: [], columns: [], rowsAffected: 0 };
      }),
      close: vi.fn(),
    } as unknown as Client;

    const missing = await localMissingRemoteTables(remote, ["audits"]);
    expect(missing).toEqual(["audit_modules"]);
  });
});
