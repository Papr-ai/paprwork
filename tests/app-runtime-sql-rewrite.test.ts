import { describe, expect, it } from "vitest";
import { rewriteSqlForTurso, displayTableName } from "../src/gateway/services/appRuntime/rewriteSqlForTurso.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import {
  assertExecSql,
  assertReadOnlySql,
  assertWriteSql,
} from "../src/gateway/services/appRuntime/sqlValidation.js";

const source: AppDataSource = {
  id: "src-1",
  type: "sqlite",
  jobId: "abc-123",
  alias: "main",
  dbPath: "/tmp/data.db",
  tables: ["campaigns", "leads"],
  linkedAt: new Date().toISOString(),
};

describe("rewriteSqlForTurso", () => {
  it("passes SQL through unchanged in per-job Turso mode", () => {
    const sql = "SELECT * FROM campaigns WHERE id = ?";
    const out = rewriteSqlForTurso(sql, source, ["campaigns", "leads"]);
    expect(out).toBe(sql);
  });

  it("returns table names as-is for display", () => {
    expect(displayTableName("leads", "abc-123")).toBe("leads");
    expect(displayTableName("job_runs", "abc-123")).toBeNull();
  });
});

describe("sqlValidation", () => {
  it("allows SELECT and rejects INSERT on query route", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
    expect(() => assertReadOnlySql("INSERT INTO x VALUES (1)")).toThrow();
  });

  it("allows write statements on write route", () => {
    expect(() => assertWriteSql("UPDATE campaigns SET x = 1")).not.toThrow();
    expect(() => assertWriteSql("SELECT 1")).toThrow();
  });

  it("allows CREATE TABLE IF NOT EXISTS on exec route", () => {
    expect(() =>
      assertExecSql("CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)"),
    ).not.toThrow();
    expect(() => assertExecSql("DROP TABLE foo")).toThrow();
  });
});
