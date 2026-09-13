import { describe, expect, it } from "vitest";
import { buildCatalogAutomationForApp } from "../src/core/utils/catalogAutomation.js";
import { humanizeJobCron } from "../src/core/utils/jobScheduleLabel.js";

describe("catalogAutomation", () => {
  it("humanizes weekday morning cron", () => {
    expect(humanizeJobCron("0 8 * * 1-5")).toBe("every weekday at 8 am");
  });

  it("builds card line for a single scheduled agent job", () => {
    const result = buildCatalogAutomationForApp("app-1", [
      {
        name: "Daily digest",
        type: "agent",
        appIds: ["app-1"],
        schedule: { enabled: true, cron: "0 8 * * 1-5" },
      },
    ]);

    expect(result).toEqual({
      scheduleLabel: "every weekday at 8 am",
      scheduledJobCount: 1,
      hasAgentJob: true,
      cardLine: "App plus a job that runs every weekday at 8 am",
    });
  });

  it("builds plural card line for multiple scheduled jobs", () => {
    const result = buildCatalogAutomationForApp("app-1", [
      {
        name: "Hourly scorer",
        type: "python",
        appIds: ["app-1"],
        schedule: { enabled: true, intervalMs: 3_600_000 },
      },
      {
        name: "Daily digest",
        type: "agent",
        appIds: ["app-1"],
        schedule: { enabled: true, cron: "0 8 * * *" },
      },
    ]);

    expect(result?.scheduledJobCount).toBe(2);
    expect(result?.cardLine).toBe("App plus 2 scheduled jobs");
    expect(result?.hasAgentJob).toBe(true);
  });

  it("returns null when no enabled schedule is linked", () => {
    const result = buildCatalogAutomationForApp("app-1", [
      {
        name: "Manual only",
        type: "agent",
        appIds: ["app-1"],
      },
      {
        name: "Other app",
        type: "agent",
        appIds: ["app-2"],
        schedule: { enabled: true, intervalMs: 60_000 },
      },
    ]);

    expect(result).toBeNull();
  });
});
