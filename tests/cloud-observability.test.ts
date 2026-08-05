import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "../src/gateway/services/CloudObservabilityService.js";

describe("assertReadOnlySql", () => {
  it("allows SELECT and WITH queries", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
    expect(() =>
      assertReadOnlySql("WITH cte AS (SELECT 1 AS x) SELECT * FROM cte"),
    ).not.toThrow();
  });

  it("allows PRAGMA and EXPLAIN", () => {
    expect(() => assertReadOnlySql("PRAGMA table_info(audits)")).not.toThrow();
    expect(() => assertReadOnlySql("EXPLAIN SELECT * FROM audits")).not.toThrow();
  });

  it("rejects writes and DDL", () => {
    expect(() => assertReadOnlySql("INSERT INTO t VALUES (1)")).toThrow(
      /read-only/i,
    );
    expect(() => assertReadOnlySql("DELETE FROM t")).toThrow(/read-only/i);
    expect(() => assertReadOnlySql("DROP TABLE t")).toThrow(/read-only/i);
  });

  it("rejects empty SQL", () => {
    expect(() => assertReadOnlySql("   ")).toThrow(/required/i);
  });
});
