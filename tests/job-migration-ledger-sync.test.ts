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
});
