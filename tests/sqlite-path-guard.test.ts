import { describe, expect, test } from "vitest";
import {
  buildSqlitePathWarnings,
  commandHasSqliteWrite,
  extractSqliteDbPaths,
} from "../src/core/utils/sqlitePathGuard.js";

describe("sqlitePathGuard", () => {
  test("detects sqlite3 write commands", () => {
    expect(
      commandHasSqliteWrite(
        'sqlite3 "/tmp/foo.db" "INSERT INTO t VALUES (1)"',
      ),
    ).toBe(true);
    expect(
      commandHasSqliteWrite('sqlite3 "/tmp/foo.db" "SELECT 1"'),
    ).toBe(false);
  });

  test("extracts db paths from sqlite3 invocations", () => {
    const paths = extractSqliteDbPaths(
      'sqlite3 ~/Papr/apps/app-id/database.sqlite "CREATE TABLE x(id INT)"',
    );
    expect(paths).toContain("~/Papr/apps/app-id/database.sqlite");
  });

  test("allows writes to PAPR_DB paths from env", () => {
    const db = "/Users/test/Papr/data/databases/billing/data.db";
    const prev = process.env.PAPR_DB_BILLING;
    process.env.PAPR_DB_BILLING = db;
    try {
      const warnings = buildSqlitePathWarnings(
        `sqlite3 "${db}" "INSERT INTO invoices VALUES (1)"`,
        {},
      );
      expect(warnings).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PAPR_DB_BILLING;
      else process.env.PAPR_DB_BILLING = prev;
    }
  });

  test("warns on app-folder sqlite writes outside APP_DB", () => {
    const home = process.env.HOME ?? "/Users/test";
    const warnings = buildSqlitePathWarnings(
      `sqlite3 "${home}/Papr/apps/abc/database.sqlite" "INSERT INTO t VALUES (1)"`,
      { appDb: `${home}/Papr/jobs/job-1/data/data.db` },
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("APP_DB");
  });

  test("allows writes to APP_DB path", () => {
    const db = "/Users/test/Papr/jobs/job-1/data/data.db";
    const warnings = buildSqlitePathWarnings(
      `sqlite3 "${db}" "INSERT INTO clients VALUES (1, 'x')"`,
      { appDb: db },
    );
    expect(warnings).toEqual([]);
  });

  test("warns on non-canonical job root db writes with capital Jobs path", () => {
    const home = process.env.HOME ?? "/Users/test";
    const warnings = buildSqlitePathWarnings(
      `sqlite3 "${home}/Papr/Jobs/job-1/audit.db" "UPDATE t SET x=1"`,
      {
        appDb: `${home}/Papr/Jobs/job-1/data/data.db`,
        jobDb: `${home}/Papr/Jobs/job-1/data/data.db`,
      },
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("warns on non-canonical job root db writes", () => {
    const home = process.env.HOME ?? "/Users/test";
    const warnings = buildSqlitePathWarnings(
      `sqlite3 "${home}/Papr/jobs/job-1/audit.db" "UPDATE t SET x=1"`,
      {
        appDb: `${home}/Papr/jobs/job-1/data/data.db`,
        jobDb: `${home}/Papr/jobs/job-1/data/data.db`,
      },
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("non-canonical");
  });
});
