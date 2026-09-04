import { afterEach, describe, expect, test } from "vitest";
import { execSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseDataContract,
  validateDatabaseAgainstContract,
  type DataContract,
} from "../src/gateway/services/dataContract.js";

function createTestDb(sql: string): string {
  const dbPath = join(
    tmpdir(),
    `papr-contract-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const sqlFile = `${dbPath}.sql`;
  writeFileSync(sqlFile, sql, "utf8");
  execSync(`sqlite3 "${dbPath}" < "${sqlFile}"`, { stdio: "pipe" });
  unlinkSync(sqlFile);
  return dbPath;
}

describe("dataContract", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      if (existsSync(p)) unlinkSync(p);
    }
    dbPaths.length = 0;
  });

  test("parseDataContract requires version", () => {
    expect(() => parseDataContract("{}")).toThrow(/version/);
    const contract = parseDataContract('{"version": 1}');
    expect(contract.version).toBe(1);
  });

  test("parseDataContract accepts enforceOnFailure flag", () => {
    const contract = parseDataContract(
      JSON.stringify({ version: 1, enforceOnFailure: true }),
    );
    expect(contract.enforceOnFailure).toBe(true);
    const defaultContract = parseDataContract(JSON.stringify({ version: 1 }));
    expect(defaultContract.enforceOnFailure).toBeUndefined();
  });

  test("passes when tables meet minRows and enums", async () => {
    const dbPath = createTestDb(`
      CREATE TABLE report_evidence (
        id INTEGER PRIMARY KEY,
        section_id INTEGER,
        section_kind TEXT,
        evidence_json TEXT
      );
      INSERT INTO report_evidence (section_id, section_kind, evidence_json)
      VALUES (1, 'findings', '[]'), (2, 'overview', '[]');
    `);
    dbPaths.push(dbPath);

    const contract: DataContract = {
      version: 1,
      tables: {
        report_evidence: {
          requiredColumns: ["section_id", "section_kind", "evidence_json"],
          enums: {
            section_kind: [
              "overview",
              "diagnosis",
              "findings",
              "recommendations",
              "roadmap",
            ],
          },
          minRows: 1,
        },
      },
    };

    const result = await validateDatabaseAgainstContract(dbPath, contract);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("fails on invalid enum values", async () => {
    const dbPath = createTestDb(`
      CREATE TABLE report_evidence (section_kind TEXT);
      INSERT INTO report_evidence VALUES ('report'), ('findings');
    `);
    dbPaths.push(dbPath);

    const contract: DataContract = {
      version: 1,
      tables: {
        report_evidence: {
          enums: { section_kind: ["findings", "overview"] },
        },
      },
    };

    const result = await validateDatabaseAgainstContract(dbPath, contract);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.message.includes("report"))).toBe(
      true,
    );
  });

  test("applies job-specific minRows checks", async () => {
    const dbPath = createTestDb(`
      CREATE TABLE report_content (id INTEGER PRIMARY KEY);
      INSERT INTO report_content VALUES (1);
    `);
    dbPaths.push(dbPath);

    const contract: DataContract = {
      version: 1,
      jobs: {
        "Report Generator": {
          minRows: { report_content: 5 },
        },
      },
    };

    const fail = await validateDatabaseAgainstContract(dbPath, contract, {
      jobName: "Report Generator",
    });
    expect(fail.passed).toBe(false);

    const skip = await validateDatabaseAgainstContract(dbPath, contract, {
      jobName: "Other Job",
    });
    expect(skip.passed).toBe(true);
  });

  test("fails when required column missing", async () => {
    const dbPath = createTestDb(`
      CREATE TABLE perspective_scores (score INTEGER);
    `);
    dbPaths.push(dbPath);

    const contract: DataContract = {
      version: 1,
      tables: {
        perspective_scores: {
          requiredColumns: ["agent_notes"],
        },
      },
    };

    const result = await validateDatabaseAgainstContract(dbPath, contract);
    expect(result.passed).toBe(false);
    expect(result.violations[0].message).toContain("agent_notes");
  });

  test("requireTodayRow fails when today's brief missing", async () => {
    const dbPath = createTestDb(`
      CREATE TABLE briefs (date TEXT, brief_json TEXT);
      INSERT INTO briefs VALUES ('2020-01-01', '{}');
    `);
    dbPaths.push(dbPath);

    const contract: DataContract = {
      version: 1,
      enforceOnFailure: true,
      jobs: {
        "Daily Brief Generator": {
          requireTodayRow: { briefs: "date" },
        },
      },
    };

    const result = await validateDatabaseAgainstContract(dbPath, contract, {
      jobName: "Daily Brief Generator",
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.message.includes("today"))).toBe(true);
  });
});
