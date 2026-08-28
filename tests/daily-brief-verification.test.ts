import { afterEach, describe, expect, test } from "vitest";
import { execSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  todayUtcDateKey,
  verifyDailyBriefRowForToday,
} from "../src/gateway/services/jobs/dailyBriefVerification.js";

function createTestDb(sql: string): string {
  const dbPath = join(
    tmpdir(),
    `papr-brief-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const sqlFile = `${dbPath}.sql`;
  writeFileSync(sqlFile, sql, "utf8");
  execSync(`sqlite3 "${dbPath}" < "${sqlFile}"`, { stdio: "pipe" });
  unlinkSync(sqlFile);
  return dbPath;
}

describe("dailyBriefVerification", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  test("passes when today's row exists", () => {
    const today = todayUtcDateKey();
    const dbPath = createTestDb(`
      CREATE TABLE briefs (date TEXT, brief_json TEXT);
      INSERT INTO briefs VALUES ('${today}', '{"hero":{}}');
    `);
    dbPaths.push(dbPath);

    const result = verifyDailyBriefRowForToday(dbPath);
    expect(result.ok).toBe(true);
  });

  test("fails when today's row missing", () => {
    const dbPath = createTestDb(`
      CREATE TABLE briefs (date TEXT, brief_json TEXT);
      INSERT INTO briefs VALUES ('2020-01-01', '{"hero":{}}');
    `);
    dbPaths.push(dbPath);

    const result = verifyDailyBriefRowForToday(dbPath);
    expect(result.ok).toBe(false);
  });
});
