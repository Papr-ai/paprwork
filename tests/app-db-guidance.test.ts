import { describe, expect, test } from "vitest";
import {
  buildAppDbBashGuidance,
  buildAppDbRunJobFailureReminder,
} from "../src/core/utils/appDbGuidance.js";

describe("appDbGuidance", () => {
  test("warns on papr_jobs.db references", () => {
    const guidance = buildAppDbBashGuidance(
      'sqlite3 ~/Papr/papr_jobs.db "SELECT * FROM meetings"',
    );
    expect(guidance).toContain("papr_jobs.db does not exist");
    expect(guidance).toContain("$APP_DB");
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
    expect(reminder).toContain("$APP_DB");
  });

  test("skips run job failure reminder for standalone jobs", () => {
    expect(
      buildAppDbRunJobFailureReminder("no such table: meetings", []),
    ).toBeUndefined();
  });
});
