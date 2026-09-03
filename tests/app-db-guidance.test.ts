import { describe, expect, test } from "vitest";
import {
  buildAppDbBashGuidance,
  buildAppDbJobReminder,
  buildAppDbRunJobFailureReminder,
} from "../src/core/utils/appDbGuidance.js";

describe("appDbGuidance", () => {
  test("warns on papr_jobs.db references", () => {
    const guidance = buildAppDbBashGuidance(
      'sqlite3 ~/Papr/papr_jobs.db "SELECT * FROM meetings"',
    );
    expect(guidance).toContain("papr_jobs.db does not exist");
    expect(guidance).toContain("PAPR_DB_*");
  });

  test("warns on sqlite against jobs.json", () => {
    const guidance = buildAppDbBashGuidance(
      'sqlite3 ~/Papr/data/jobs.json ".tables"',
    );
    expect(guidance).toContain("jobs.json is JSON metadata");
  });

  test("run job failure reminder on sqlite errors for linked apps", () => {
    const reminder = buildAppDbRunJobFailureReminder(
      "sqlite3.OperationalError: no such table: meetings",
      ["app-123"],
    );
    expect(reminder).toContain("validate_job");
    expect(reminder).toContain("PAPR_DB_*");
  });

  test("skips run job failure reminder for standalone jobs", () => {
    expect(
      buildAppDbRunJobFailureReminder("no such table: meetings", []),
    ).toBeUndefined();
  });

  test("agent job with persist intent and no writeDbIds warns", () => {
    const reminder = buildAppDbJobReminder(
      "agent",
      "Scrape LinkedIn and save results to database",
      ["app-123"],
      [],
    );
    expect(reminder).toContain("no writeDbIds");
    expect(reminder).toContain("$JOB_DB");
  });

  test("agent job with writeDbIds and save intent reminds registry path", () => {
    const reminder = buildAppDbJobReminder(
      "agent",
      "Save top insights from this run",
      ["app-123"],
      ["db-metrics"],
    );
    expect(reminder).toContain("PAPR_DB_*");
    expect(reminder).toContain("NOT $JOB_DB");
  });
});
