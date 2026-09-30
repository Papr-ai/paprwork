import { describe, expect, test } from "vitest";
import { msUntilSoonestNextRun } from "../src/gateway/services/jobs/scheduleEngine.js";

describe("msUntilSoonestNextRun cloud deferral", () => {
  test("skips cloud-preferred due jobs for wake timer when deferred locally", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 120_000).toISOString();
    const ms = msUntilSoonestNextRun(
      [
        {
          id: "cloud-preferred-due",
          schedule: { enabled: true, intervalMs: 60_000 },
          scheduleState: { nextRunAt: past },
          executionCapability: "cloud-preferred",
        },
        {
          id: "local-preferred-later",
          schedule: { enabled: true, intervalMs: 60_000 },
          scheduleState: { nextRunAt: future },
          executionCapability: "local-preferred",
        },
      ],
      Date.now(),
      new Set(),
      (job) => job.executionCapability === "cloud-preferred",
    );
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(60_000);
  });

  test("returns 0 when a locally runnable job is due", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const ms = msUntilSoonestNextRun(
      [
        {
          id: "local-due",
          schedule: { enabled: true, intervalMs: 60_000 },
          scheduleState: { nextRunAt: past },
          executionCapability: "local-preferred",
        },
      ],
      Date.now(),
    );
    expect(ms).toBe(0);
  });
});
