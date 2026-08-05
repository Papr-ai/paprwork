import { describe, expect, test } from "vitest";
import {
  commandHasSqliteDdl,
  detectJobDbSchemaDdlBlock,
  isSyncedPaprDatabasePath,
  migrationPathForDb,
} from "../src/core/utils/jobDbSchemaGuard.js";

describe("jobDbSchemaGuard", () => {
  test("detects ALTER TABLE in sqlite3 commands", () => {
    expect(
      commandHasSqliteDdl(
        'sqlite3 "/tmp/x.db" "ALTER TABLE audits ADD COLUMN contact_name TEXT"',
      ),
    ).toBe(true);
    expect(
      commandHasSqliteDdl('sqlite3 "/tmp/x.db" "SELECT * FROM audits"'),
    ).toBe(false);
  });

  test("identifies synced Papr database paths", () => {
    expect(
      isSyncedPaprDatabasePath(
        "/Users/test/Papr/Jobs/abc-123/data/data.db",
      ),
    ).toBe(true);
    expect(
      isSyncedPaprDatabasePath(
        "/Users/test/Papr/data/databases/billing/data.db",
      ),
    ).toBe(true);
    expect(isSyncedPaprDatabasePath("/tmp/scratch.db")).toBe(false);
  });

  test("blocks ALTER on job data.db with migration guidance", () => {
    const home = process.env.HOME ?? "/Users/test";
    const db = `${home}/Papr/Jobs/job-1/data/data.db`;
    const block = detectJobDbSchemaDdlBlock(
      `sqlite3 "${db}" "ALTER TABLE audits ADD COLUMN contact_name TEXT"`,
    );
    expect(block).not.toBeNull();
    expect(block?.message).toContain("write_file");
    expect(block?.message).toContain("migrations");
    expect(block?.suggestedSql).toContain("contact_name");
  });

  test("blocks ALTER via $JOB_DB env var", () => {
    const home = process.env.HOME ?? "/Users/test";
    const db = `${home}/Papr/Jobs/job-1/data/data.db`;
    const block = detectJobDbSchemaDdlBlock(
      'sqlite3 "$JOB_DB" "ALTER TABLE audits ADD COLUMN contact_name TEXT"',
      {
        jobDb: db,
        env: { JOB_DB: db },
      },
    );
    expect(block).not.toBeNull();
  });

  test("allows INSERT on synced db (data writes OK via bash)", () => {
    const home = process.env.HOME ?? "/Users/test";
    const db = `${home}/Papr/Jobs/job-1/data/data.db`;
    const block = detectJobDbSchemaDdlBlock(
      `sqlite3 "${db}" "INSERT INTO audits (id) VALUES ('a1')"`,
    );
    expect(block).toBeNull();
  });

  test("allows ALTER on non-synced scratch db", () => {
    const block = detectJobDbSchemaDdlBlock(
      'sqlite3 "/tmp/scratch.db" "ALTER TABLE t ADD COLUMN x TEXT"',
    );
    expect(block).toBeNull();
  });

  test("migrationPathForDb resolves job and registry layouts", () => {
    expect(
      migrationPathForDb("/Users/test/Papr/Jobs/abc/data/data.db"),
    ).toContain("Jobs/abc/migrations/");
    expect(
      migrationPathForDb("/Users/test/Papr/data/databases/billing/data.db"),
    ).toContain("databases/billing/migrations/");
  });
});
