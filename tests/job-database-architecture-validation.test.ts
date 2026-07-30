import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { validateJobAgainstAppDatabase } from "../src/gateway/services/jobs/jobDatabaseArchitectureValidation.js";

const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "papr-job-schema-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "data.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE user_settings (id INTEGER PRIMARY KEY, niche TEXT, audience TEXT)");
  db.close();
  return dbPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateJobAgainstAppDatabase", () => {
  it("reports missing primary database path instead of throwing", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: path.join(tmpdir(), "missing", "data.db"),
      command: `sqlite3 "$APP_DB" 'SELECT 1'`,
    });
    expect(issues.some((issue) => issue.rule === "primary-database-missing")).toBe(true);
  });

  it("finds missing referenced tables", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: fixture(),
      command: `sqlite3 "$APP_DB" 'INSERT INTO blog_picks(title) VALUES (?)'`,
    });
    expect(issues.some((issue) => issue.rule === "job-table-missing-on-primary")).toBe(true);
  });

  it("finds INSERT and UPDATE column drift", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: fixture(),
      command: `sqlite3 "$APP_DB" 'UPDATE user_settings SET business_focus = ? WHERE id = 1'`,
    });
    expect(issues.some((issue) => issue.rule === "job-column-missing-on-primary")).toBe(true);
  });

  it("validates required contract tables and columns", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: fixture(),
      command: "SELECT 1",
      contract: {
        tables: {
          user_settings: { requiredColumns: ["id", "niche", "tone"] },
          blog_picks: { requiredColumns: ["id"] },
        },
      },
    });
    expect(issues.map((issue) => issue.rule)).toEqual(
      expect.arrayContaining(["data-contract-column-missing", "data-contract-table-missing"]),
    );
  });

  it("allows a migration job to create contracted schema", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: fixture(),
      command: `sqlite3 "$APP_DB" 'ALTER TABLE user_settings ADD COLUMN tone TEXT; CREATE TABLE IF NOT EXISTS blog_picks (id INTEGER PRIMARY KEY)'`,
      contract: {
        tables: {
          user_settings: { requiredColumns: ["id", "niche", "tone"] },
          blog_picks: { requiredColumns: ["id"] },
        },
      },
    });
    expect(issues).toHaveLength(0);
  });

  it("accepts matching APP_DB writes with a matching contract", () => {
    const issues = validateJobAgainstAppDatabase({
      databasePath: fixture(),
      command: `sqlite3 "$APP_DB" 'UPDATE user_settings SET niche = ?, audience = ? WHERE id = 1'`,
      contract: {
        tables: {
          user_settings: { requiredColumns: ["id", "niche", "audience"] },
        },
      },
    });
    expect(issues).toHaveLength(0);
  });
});
