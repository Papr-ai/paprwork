import { describe, expect, it } from "vitest";

import {
  assertReplaySafeRowSql,
  NonReplaySafeSqlError,
} from "../src/gateway/services/syncV3/replaySafeSql.js";

describe("assertReplaySafeRowSql", () => {
  it("allows INSERT and absolute UPDATE", () => {
    expect(() =>
      assertReplaySafeRowSql("INSERT INTO t (a) VALUES (1)"),
    ).not.toThrow();
    expect(() =>
      assertReplaySafeRowSql("UPDATE t SET count = 5 WHERE id = 1"),
    ).not.toThrow();
  });

  it("rejects increment-style UPDATE", () => {
    expect(() =>
      assertReplaySafeRowSql("UPDATE t SET count = count + 1 WHERE id = 1"),
    ).toThrow(NonReplaySafeSqlError);
  });
});
