import { describe, expect, test } from "vitest";
import {
  computeFollowingNextRunAt,
  computeInitialNextRunAt,
  computeMisfireSkipNextRunAt,
  isScheduleDue,
  msUntilSoonestNextRun,
} from "../src/gateway/services/jobs/scheduleEngine.js";

describe("scheduleEngine", () => {
  test("isScheduleDue uses nextRunAt", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      isScheduleDue(
        { enabled: true, intervalMs: 1000 },
        { nextRunAt: past },
        new Date(),
      ),
    ).toBe(true);
    expect(
      isScheduleDue(
        { enabled: true, intervalMs: 1000 },
        { nextRunAt: new Date(Date.now() + 60_000).toISOString() },
        new Date(),
      ),
    ).toBe(false);
  });

  test("msUntilSoonestNextRun skips running jobs", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const ms = msUntilSoonestNextRun(
      [
        {
          schedule: { enabled: true, cron: "* * * * *" },
          scheduleState: { nextRunAt: future },
          status: "running",
        },
      ],
      Date.now(),
    );
    expect(ms).toBe(null);
  });

  test("computeMisfireSkipNextRunAt advances interval", () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    const next = computeMisfireSkipNextRunAt(
      { enabled: true, intervalMs: 5000 },
      now,
    );
    expect(next).toBe(new Date(now.getTime() + 5000).toISOString());
  });

  test("computeInitialNextRunAt for cron returns a future ISO", () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    const next = computeInitialNextRunAt(
      { enabled: true, cron: "0 13 * * *" },
      now,
      {},
    );
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(now.getTime());
  });

  test("computeFollowingNextRunAt for every-minute cron is strictly after anchor", () => {
    const anchor = new Date("2025-06-01T12:00:00.000Z");
    const next = computeFollowingNextRunAt(
      { enabled: true, cron: "* * * * *" },
      anchor,
    );
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(anchor.getTime());
  });
});
