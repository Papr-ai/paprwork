import { describe, expect, it } from "vitest";
import {
  parseCreateIndexStatement,
  splitSqlStatements,
} from "../src/gateway/services/jobs/migrationSqlHelpers.js";

describe("splitSqlStatements", () => {
  it("keeps CREATE TABLE after leading line comments in the same chunk", () => {
    const sql = `-- header comment
-- second line
CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS daily_metrics (id TEXT PRIMARY KEY);`;

    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS shops/i);
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS daily_metrics/i);
  });

  it("parses CREATE INDEX statements", () => {
    const sql =
      "CREATE INDEX IF NOT EXISTS idx_daily_shop_date ON daily_metrics(shop_id, date);";
    expect(splitSqlStatements(sql)).toEqual([sql.replace(";", "")]);
    expect(parseCreateIndexStatement(sql)).toEqual({
      indexName: "idx_daily_shop_date",
    });
  });
});
