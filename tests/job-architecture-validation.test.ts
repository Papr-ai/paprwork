import { describe, expect, it } from "vitest";
import {
  formatJobArchitectureErrors,
  validateJobArchitecture,
} from "../src/gateway/services/jobs/jobArchitectureValidation.js";

const APP_ID = "app-123";

function validate(command: string) {
  return validateJobArchitecture({
    type: "agent",
    command,
    appIds: [APP_ID],
  });
}

describe("validateJobArchitecture", () => {
  it("blocks SQL mutations through /api/db/query", () => {
    const issues = validate(
      `curl http://localhost:3000/api/db/query -d '{"sql":"UPDATE user_settings SET niche = ?"}'`,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "job-db-query-write-forbidden",
          severity: "error",
        }),
      ]),
    );
  });

  it("allows portable Papr job paths via PAPR_HOME", () => {
    const issues = validate(
      'sqlite3 "$PAPR_HOME/Jobs/abc/data/data.db" "SELECT 1"',
    );
    expect(
      issues.some((issue) => issue.rule === "job-hardcoded-user-path"),
    ).toBe(false);
  });

  it("blocks machine-specific Papr job paths", () => {
    const issues = validate(
      "sqlite3 /Users/alice/Papr/Jobs/abc/data/data.db 'SELECT 1'",
    );
    expect(
      issues.some((issue) => issue.rule === "job-hardcoded-user-path"),
    ).toBe(true);
  });

  it("blocks cross-job job.json handoffs", () => {
    const issues = validate(
      "Read ~/Papr/Jobs/other-job/job.json and parse lastOutput",
    );
    expect(
      issues.some((issue) => issue.rule === "job-cross-job-filesystem-access"),
    ).toBe(true);
  });

  it("blocks app-facing mutations through JOB_DB", () => {
    const issues = validate(
      "sqlite3 \"$JOB_DB\" 'INSERT INTO blog_picks(title) VALUES (?)'",
    );
    expect(
      issues.some((issue) => issue.rule === "job-ui-table-on-job-db"),
    ).toBe(true);
  });

  it("allows checkpoint mutations through JOB_DB", () => {
    const issues = validate(
      "sqlite3 \"$JOB_DB\" 'INSERT INTO job_runs(run_id) VALUES (?)'",
    );
    expect(
      issues.some((issue) => issue.rule === "job-ui-table-on-job-db"),
    ).toBe(false);
  });

  it("blocks app-linked jobs that depend on localhost DB writes", () => {
    const issues = validate(
      'curl http://127.0.0.1:3000/api/db/write -d \'{"sql":"UPDATE blog_picks SET title = ?"}\'',
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "job-desktop-api-dependency",
          severity: "error",
        }),
      ]),
    );
    expect(formatJobArchitectureErrors(issues)).toContain(
      "job-desktop-api-dependency",
    );
  });

  it("allows portable APP_DB writes", () => {
    const issues = validate(
      "sqlite3 \"$APP_DB\" 'UPDATE user_settings SET niche = ?'",
    );
    expect(issues).toHaveLength(0);
  });
});
