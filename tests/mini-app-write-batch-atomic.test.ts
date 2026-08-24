import { describe, expect, test } from "vitest";

import { isMiniAppWriteSql } from "../src/gateway/services/miniAppWriteBatch.js";

describe("miniAppWriteBatch helpers", () => {
  test("isMiniAppWriteSql accepts write verbs", () => {
    expect(isMiniAppWriteSql("INSERT INTO t (x) VALUES (1)")).toBe(true);
    expect(isMiniAppWriteSql("UPDATE t SET x = 1")).toBe(true);
    expect(isMiniAppWriteSql("DELETE FROM t")).toBe(true);
    expect(isMiniAppWriteSql("REPLACE INTO t (x) VALUES (1)")).toBe(true);
    expect(isMiniAppWriteSql("UPSERT INTO t (x) VALUES (1)")).toBe(true);
  });

  test("isMiniAppWriteSql rejects reads", () => {
    expect(isMiniAppWriteSql("SELECT * FROM t")).toBe(false);
  });
});
