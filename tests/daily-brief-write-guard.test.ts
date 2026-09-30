import { describe, expect, it } from "vitest";
import { assertValidHomeBriefWrite } from "../src/gateway/services/dailyBriefWriteGuard.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import { DEFAULT_HOME_APP_ID } from "../src/gateway/services/defaultHomeBundle.js";

const homeBriefsSource: AppDataSource = {
  id: "src-1",
  type: "sqlite",
  jobId: "job-1",
  alias: "Daily Brief Generator",
  dbPath: "/tmp/home-daily-briefs/data.db",
  tables: ["briefs"],
  linkedAt: "2026-01-01T00:00:00.000Z",
};

describe("dailyBriefWriteGuard", () => {
  it("rejects test date keys and empty brief JSON for Home briefs writes", () => {
    expect(() =>
      assertValidHomeBriefWrite(
        DEFAULT_HOME_APP_ID,
        homeBriefsSource,
        "INSERT OR REPLACE INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
        ["2026-09-02-test", "{}"],
      ),
    ).toThrow(/YYYY-MM-DD/);

    expect(() =>
      assertValidHomeBriefWrite(
        DEFAULT_HOME_APP_ID,
        homeBriefsSource,
        "INSERT OR REPLACE INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
        [
          "2026-09-02",
          JSON.stringify({ hero: { title: "Daily Brief" }, sections: [] }),
        ],
      ),
    ).toThrow(/sections/);
  });

  it("allows valid brief writes", () => {
    expect(() =>
      assertValidHomeBriefWrite(
        DEFAULT_HOME_APP_ID,
        homeBriefsSource,
        "INSERT OR REPLACE INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
        [
          "2026-09-02",
          JSON.stringify({
            hero: { title: "Daily Brief" },
            sections: [{ type: "freeform", content: "ok" }],
          }),
        ],
      ),
    ).not.toThrow();
  });
});
