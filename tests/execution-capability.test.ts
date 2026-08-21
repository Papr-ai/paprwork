import { describe, expect, test } from "vitest";
import {
  DEFAULT_JOB_EXECUTION_CAPABILITY,
  isJobDeferredToCloudScheduler,
  normalizeExecutionCapability,
  shouldDesktopSchedulerRunJob,
} from "../src/gateway/services/jobs/executionCapability.js";

describe("executionCapability", () => {
  test("defaults unset and legacy cloud-capable to local-preferred", () => {
    expect(normalizeExecutionCapability(undefined)).toBe("local-preferred");
    expect(normalizeExecutionCapability("cloud-capable")).toBe("local-preferred");
    expect(DEFAULT_JOB_EXECUTION_CAPABILITY).toBe("local-preferred");
  });

  test("desktop runs local-preferred when cloud scheduler is authoritative", () => {
    expect(
      shouldDesktopSchedulerRunJob({ executionCapability: undefined }, true),
    ).toBe(true);
    expect(
      shouldDesktopSchedulerRunJob(
        { executionCapability: "local-preferred" },
        true,
      ),
    ).toBe(true);
    expect(
      shouldDesktopSchedulerRunJob(
        { executionCapability: "cloud-capable" },
        true,
      ),
    ).toBe(true);
    expect(
      shouldDesktopSchedulerRunJob({ executionCapability: "local-only" }, true),
    ).toBe(true);
  });

  test("desktop defers only cloud-preferred when cloud scheduler is authoritative", () => {
    expect(
      shouldDesktopSchedulerRunJob(
        { executionCapability: "cloud-preferred" },
        true,
      ),
    ).toBe(false);
    expect(
      isJobDeferredToCloudScheduler(
        { executionCapability: "cloud-preferred" },
        true,
      ),
    ).toBe(true);
    expect(
      isJobDeferredToCloudScheduler({ executionCapability: undefined }, true),
    ).toBe(false);
  });

  test("cloud sync off runs everything locally regardless of capability", () => {
    expect(
      shouldDesktopSchedulerRunJob(
        { executionCapability: "cloud-preferred" },
        false,
      ),
    ).toBe(true);
    expect(
      isJobDeferredToCloudScheduler(
        { executionCapability: "cloud-preferred" },
        false,
      ),
    ).toBe(false);
  });
});
