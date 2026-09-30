import { describe, expect, it } from "vitest";
import { buildAppsHealth } from "../src/core/utils/appsHealth.js";

const job = (over: Partial<Parameters<typeof buildAppsHealth>[0][number]>) => ({
  id: "j",
  name: "Job",
  appIds: ["app-1"],
  status: "completed",
  ...over,
});

describe("buildAppsHealth", () => {
  it("returns one entry per linked app and ignores unlinked jobs", () => {
    const map = buildAppsHealth([
      job({ appIds: ["a", "b"] }),
      job({ appIds: [] }),
    ]);
    expect(Object.keys(map).sort()).toEqual(["a", "b"]);
  });

  it("reports a scheduled job's label and last successful run", () => {
    const map = buildAppsHealth([
      job({
        schedule: { enabled: true, cron: "0 9 * * *" },
        lastRunAt: "2026-01-01T09:00:00Z",
        scheduleState: { nextRunAt: "2026-01-02T09:00:00Z" },
      }),
    ]);
    expect(map["app-1"]).toMatchObject({
      state: "ok",
      scheduleLabel: "daily at 9 am",
      scheduledJobCount: 1,
      lastRunAt: "2026-01-01T09:00:00Z",
      nextRunAt: "2026-01-02T09:00:00Z",
    });
  });

  it("failure wins over other jobs and keeps only the first line of the error", () => {
    const map = buildAppsHealth([
      job({ name: "A ok", status: "completed" }),
      job({
        name: "B sync",
        status: "failed",
        error: "Session expired\n  at stack line",
        scheduleState: { consecutivePermanentFailures: 3 },
      }),
      job({ name: "C run", status: "running" }),
    ]);
    expect(map["app-1"]).toMatchObject({
      state: "failed",
      failingJobName: "B sync",
      error: "Session expired",
      failureStreak: 3,
      jobCount: 3,
    });
  });

  it("marks running and never-run apps", () => {
    expect(buildAppsHealth([job({ status: "running" })])["app-1"].state).toBe(
      "running",
    );
    expect(buildAppsHealth([job({ status: "pending" })])["app-1"].state).toBe(
      "never_run",
    );
  });

  it("truncates very long errors", () => {
    const map = buildAppsHealth([
      job({ status: "failed", error: "x".repeat(500) }),
    ]);
    expect(map["app-1"].error!.length).toBeLessThanOrEqual(160);
  });
});
