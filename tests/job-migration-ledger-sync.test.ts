import { describe, expect, it } from "vitest";
import { migrationSatisfiedOnRemote } from "../src/gateway/services/jobs/jobMigrationLedgerSync.js";
import { createMigrationMockRemote } from "./helpers/migrationMockRemote.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("migrationSatisfiedOnRemote", () => {
  it("returns true when CREATE TABLE and CREATE INDEX ops exist on remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-verify-"));
    const migrationsDir = path.join(root, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0001_init.sql"),
      `-- demo schema
CREATE TABLE IF NOT EXISTS daily_metrics (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_daily_shop_date ON daily_metrics(shop_id, date);`,
    );

    const remote = createMigrationMockRemote(
      { daily_metrics: ["id", "shop_id"] },
      ["idx_daily_shop_date"],
    );

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0001_init.sql",
    );
    expect(satisfied).toBe(true);
  });

  it("returns false when CREATE INDEX is missing on remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-verify-"));
    const migrationsDir = path.join(root, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0001_init.sql"),
      `CREATE TABLE IF NOT EXISTS daily_metrics (id TEXT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS idx_daily_shop_date ON daily_metrics(shop_id, date);`,
    );

    const remote = createMigrationMockRemote({ daily_metrics: ["id"] }, []);

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0001_init.sql",
    );
    expect(satisfied).toBe(false);
  });

  /**
   * Regression: a table rebuild wedged cloud sync permanently.
   *
   * Changing a column type or adding a PRIMARY KEY is impossible with ALTER in
   * SQLite, so the drift healer emits copy-and-swap. Verified statement by
   * statement, the CREATE of the scratch table looks unsatisfied — it was
   * renamed onto the real table name. The verdict can never change, so every
   * retry failed identically and publish stayed blocked.
   */
  it("accepts a table rebuild whose scratch table is renamed into place", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-verify-"));
    const migrationsDir = path.join(root, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0002_rebuild.sql"),
      `DROP TABLE IF EXISTS "expenses__papr_rebuild";
CREATE TABLE IF NOT EXISTS "expenses__papr_rebuild" ("id" TEXT PRIMARY KEY, "amount_cents" INTEGER);
INSERT OR IGNORE INTO "expenses__papr_rebuild" ("id") SELECT "id" FROM "expenses";
DROP TABLE IF EXISTS "expenses__papr_old";
ALTER TABLE "expenses" RENAME TO "expenses__papr_old";
ALTER TABLE "expenses__papr_rebuild" RENAME TO "expenses";
DROP TABLE IF EXISTS "expenses__papr_old";`,
    );

    // Final state: only `expenses` exists. The scratch and old names are gone,
    // which is exactly what made the old verifier fail.
    const remote = createMigrationMockRemote({ expenses: ["id"] }, []);

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0002_rebuild.sql",
    );
    expect(satisfied).toBe(true);
  });

  it("accepts a table swap that drops then renames back to the same name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-verify-"));
    const migrationsDir = path.join(root, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0002_drop_manager_fk.sql"),
      `CREATE TABLE csms_new (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  manager_id INTEGER
);
INSERT INTO csms_new (id, name, manager_id) SELECT id, name, manager_id FROM csms;
DROP TABLE csms;
ALTER TABLE csms_new RENAME TO csms;
CREATE INDEX idx_csms_manager_id ON csms (manager_id);
CREATE INDEX idx_csms_role ON csms (role);`,
    );

    const remote = createMigrationMockRemote(
      { csms: ["id", "name", "manager_id"] },
      ["idx_csms_manager_id", "idx_csms_role"],
    );

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0002_drop_manager_fk.sql",
    );
    expect(satisfied).toBe(true);
  });

  it("still fails a rebuild when the final table is missing on remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-mig-verify-"));
    const migrationsDir = path.join(root, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0002_rebuild.sql"),
      `CREATE TABLE IF NOT EXISTS "expenses__papr_rebuild" ("id" TEXT PRIMARY KEY);
ALTER TABLE "expenses__papr_rebuild" RENAME TO "expenses";
CREATE INDEX IF NOT EXISTS "idx_expenses_id" ON "expenses"("id");`,
    );

    // The rename target never arrived, so this migration really is broken and
    // must still be reported unsatisfied — the fix must not blanket-pass.
    const remote = createMigrationMockRemote({}, []);

    const satisfied = await migrationSatisfiedOnRemote(
      remote,
      root,
      "0002_rebuild.sql",
    );
    expect(satisfied).toBe(false);
  });
});
