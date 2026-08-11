/**
 * Integration tests for migration apply ↔ verify parity.
 *
 * Earlier tests missed production bugs because:
 * - jobMigrationTursoSync tested APPLY (CREATE INDEX executes) but not VERIFY
 * - post-push-verify mocked Turso status and never ran migrationSatisfiedOnRemote
 * - migrationLedgerPolicy only tested baseline markers, not real SQL files
 * - splitSqlStatements had no tests for comment-prefixed migration files
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  migrationSatisfiedOnLocal,
  migrationSatisfiedOnRemote,
} from "../src/gateway/services/jobs/jobMigrationLedgerSync.js";
import { applyPendingDatabaseMigrationsToTurso } from "../src/gateway/services/jobs/jobMigrationTursoSync.js";
import { shouldVerifyMigrationOnRemote } from "../src/gateway/services/jobs/migrationLedgerPolicy.js";
import { splitSqlStatements } from "../src/gateway/services/jobs/migrationSqlHelpers.js";
import { createMigrationMockRemote } from "./helpers/migrationMockRemote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOE_MINI_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "joe-coffee-mini-init.sql",
);

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

function writeJoeMiniMigration(migrationsDir: string): void {
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.copyFileSync(
    JOE_MINI_FIXTURE,
    path.join(migrationsDir, "0001_init.sql"),
  );
}

describe("migration verify integration (joe-like fixture)", () => {
  it("parses comment-prefixed init migration with shops table and indexes", () => {
    const sql = fs.readFileSync(JOE_MINI_FIXTURE, "utf-8");
    const statements = splitSqlStatements(sql);

    expect(statements.some((s) => /CREATE TABLE.*shops/i.test(s))).toBe(true);
    expect(statements.filter((s) => /^CREATE\s+INDEX/i.test(s.trim()))).toHaveLength(
      2,
    );
    expect(statements.length).toBeGreaterThanOrEqual(5);
  });

  it("shouldVerifyMigrationOnRemote is true for real init SQL, false for baseline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
    const migrationsDir = path.join(root, "migrations");
    writeJoeMiniMigration(migrationsDir);
    fs.writeFileSync(
      path.join(migrationsDir, "0001_baseline.sql"),
      "-- registry baseline marker only\n",
    );

    expect(await shouldVerifyMigrationOnRemote(root, "0001_init.sql")).toBe(true);
    expect(await shouldVerifyMigrationOnRemote(root, "0001_baseline.sql")).toBe(
      false,
    );
  });

  it("migrationSatisfiedOnRemote passes when remote has all tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
    writeJoeMiniMigration(path.join(root, "migrations"));

    const remote = createMigrationMockRemote(
      {
        shops: ["shop_id", "name"],
        daily_metrics: ["id", "shop_id", "date"],
        menu_items: ["item_id", "shop_id", "canonical"],
      },
      ["idx_daily_shop_date", "idx_items_shop"],
    );

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0001_init.sql",
    );
    expect(satisfied).toBe(true);
  });

  it.skipIf(!canUseBetterSqlite)(
    "migrationSatisfiedOnLocal passes after applying init migration to SQLite",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
      writeJoeMiniMigration(path.join(root, "migrations"));
      const dbPath = path.join(root, "data.db");

      const sql = fs.readFileSync(JOE_MINI_FIXTURE, "utf-8");
      const db = new Database(dbPath);
      try {
        for (const statement of splitSqlStatements(sql)) {
          db.exec(`${statement};`);
        }
      } finally {
        db.close();
      }

      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const satisfied = await migrationSatisfiedOnLocal(
          verifyDb,
          root,
          "0001_init.sql",
        );
        expect(satisfied).toBe(true);
      } finally {
        verifyDb.close();
      }
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "applyPendingDatabaseMigrationsToTurso skips re-apply when ledger + schema satisfied",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
      writeJoeMiniMigration(path.join(root, "migrations"));
      const dbPath = path.join(root, "data.db");

      const sql = fs.readFileSync(JOE_MINI_FIXTURE, "utf-8");
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
          INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init.sql', datetime('now'));
        `);
        for (const statement of splitSqlStatements(sql)) {
          db.exec(`${statement};`);
        }
      } finally {
        db.close();
      }

      const remote = createMigrationMockRemote(
        {
          shops: ["shop_id", "name"],
          daily_metrics: ["id", "shop_id", "date"],
          menu_items: ["item_id", "shop_id", "canonical"],
        },
        ["idx_daily_shop_date", "idx_items_shop"],
      );
      await remote.execute({
        sql:
          "INSERT OR IGNORE INTO _papr_schema_migrations (id, applied_at, source) VALUES (?, datetime('now'), 'database_migration')",
        args: ["0001_init.sql"],
      });

      const applied = await applyPendingDatabaseMigrationsToTurso(
        remote,
        dbPath,
        root,
      );

      expect(applied).toEqual([]);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "applyPendingDatabaseMigrationsToTurso re-applies when ledger exists but indexes missing",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
      writeJoeMiniMigration(path.join(root, "migrations"));
      const dbPath = path.join(root, "data.db");

      const sql = fs.readFileSync(JOE_MINI_FIXTURE, "utf-8");
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
          INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init.sql', datetime('now'));
        `);
        for (const statement of splitSqlStatements(sql)) {
          db.exec(`${statement};`);
        }
      } finally {
        db.close();
      }

      const remote = createMigrationMockRemote(
        {
          shops: ["shop_id", "name"],
          daily_metrics: ["id", "shop_id", "date"],
          menu_items: ["item_id", "shop_id", "canonical"],
        },
        [],
      );
      await remote.execute({
        sql:
          "INSERT OR IGNORE INTO _papr_schema_migrations (id, applied_at, source) VALUES (?, datetime('now'), 'database_migration')",
        args: ["0001_init.sql"],
      });

      const applied = await applyPendingDatabaseMigrationsToTurso(
        remote,
        dbPath,
        root,
      );

      expect(applied).toEqual(["0001_init.sql"]);
    },
  );
});

describe("post-push verify migration loop (same logic as verifyTursoSourceConvergence)", () => {
  it("passes when all local migrations are satisfied on remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
    writeJoeMiniMigration(path.join(root, "migrations"));

    const remote = createMigrationMockRemote(
      {
        shops: ["shop_id", "name"],
        daily_metrics: ["id", "shop_id", "date"],
        menu_items: ["item_id", "shop_id", "canonical"],
      },
      ["idx_daily_shop_date", "idx_items_shop"],
    );

    const localMigrationIds = ["0001_baseline", "0001_init.sql"];
    const errors: string[] = [];

    for (const migrationId of localMigrationIds) {
      if (!(await shouldVerifyMigrationOnRemote(root, migrationId))) {
        continue;
      }
      const satisfied = await migrationSatisfiedOnRemote(
        remote,
        root,
        migrationId,
      );
      if (!satisfied) {
        errors.push(`Migration ${migrationId} not satisfied on Turso`);
      }
    }

    expect(errors).toEqual([]);
  });

  it("fails with the production error when CREATE INDEX missing on remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-int-"));
    writeJoeMiniMigration(path.join(root, "migrations"));

    const remote = createMigrationMockRemote(
      {
        shops: ["shop_id", "name"],
        daily_metrics: ["id", "shop_id", "date"],
        menu_items: ["item_id", "shop_id", "canonical"],
      },
      [],
    );

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0001_init.sql",
    );
    expect(satisfied).toBe(false);

    const error = satisfied
      ? null
      : "Migration 0001_init.sql not satisfied on Turso";
    expect(error).toBe("Migration 0001_init.sql not satisfied on Turso");
  });
});
