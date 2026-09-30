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

/**
 * Remote Turso stand-in backed by a real in-memory SQLite database.
 *
 * A hand-rolled SQL matcher broke every time the ledger/bootstrap SQL changed
 * (quoted ledger name, legacy-column ALTERs, index probes). Real SQLite accepts
 * whatever production sends, so these tests only pin behaviour.
 */
function createMockRemote(initialColumns: Record<string, string[]>): Client {
  const db = new Database(":memory:");
  for (const [table, cols] of Object.entries(initialColumns)) {
    const defs = cols.map((c, i) => `"${c}" TEXT${i === 0 ? " PRIMARY KEY" : ""}`);
    db.exec(`CREATE TABLE "${table}" (${defs.join(", ")})`);
  }
  return {
    execute: vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === "string" ? input : input.sql;
      const args = (typeof input === "string" ? [] : (input.args ?? [])) as unknown[];
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all(...args) as Record<string, unknown>[];
        return { rows, columns: stmt.columns().map((c) => c.name), rowsAffected: 0 };
      }
      const info = stmt.run(...args);
      return { rows: [], columns: [], rowsAffected: info.changes };
    }),
    close: vi.fn(() => db.close()),
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

      // Ledger alignment sees the columns already on Turso and backfills the
      // remote ledger up front, so nothing is left to "apply now". What matters:
      // no duplicate ADD COLUMN reached Turso, and the ledger records 0002.
      expect(applied).toEqual([]);
      const sent = vi
        .mocked(remote.execute)
        .mock.calls.map(([q]) => (typeof q === "string" ? q : q.sql));
      expect(sent.some((q) => /ALTER TABLE "?audits"? ADD COLUMN/i.test(q))).toBe(false);
      const ledger = await remote.execute("SELECT id FROM _papr_schema_migrations");
      expect(ledger.rows.map((r) => r.id)).toContain("0002_add_contact_fields.sql");
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
