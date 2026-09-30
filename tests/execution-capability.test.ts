import { describe, expect, test } from "vitest";
import {
  DEFAULT_JOB_EXECUTION_CAPABILITY,
  UNLINKED_JOB_EXECUTION_CAPABILITY,
  defaultExecutionCapabilityForAppIds,
  shouldDefaultUnlinkedJobToLocalOnly,
  isJobDeferredToCloudScheduler,
  normalizeExecutionCapability,
  shouldDesktopSchedulerRunJob,
} from "../src/gateway/services/jobs/executionCapability.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";

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

  test("standalone appIds default to local-only", () => {
    expect(UNLINKED_JOB_EXECUTION_CAPABILITY).toBe("local-only");
    expect(defaultExecutionCapabilityForAppIds([STANDALONE_APP_ID])).toBe(
      "local-only",
    );
    expect(
      defaultExecutionCapabilityForAppIds(["app-real-id"]),
    ).toBeUndefined();
    expect(
      defaultExecutionCapabilityForAppIds([STANDALONE_APP_ID], "cloud-preferred"),
    ).toBe("cloud-preferred");
  });

  test("shouldDefaultUnlinkedJobToLocalOnly skips explicit capability", () => {
    const linked = new Set(["linked-job"]);
    expect(
      shouldDefaultUnlinkedJobToLocalOnly(
        {
          id: "linked-job",
          appIds: ["app-a"],
          executionCapability: "local-preferred",
        },
        linked,
      ),
    ).toBe(false);
    expect(
      shouldDefaultUnlinkedJobToLocalOnly(
        { id: "orphan", appIds: [STANDALONE_APP_ID] },
        linked,
      ),
    ).toBe(true);
    expect(
      shouldDefaultUnlinkedJobToLocalOnly(
        { id: "ghost", appIds: ["missing-app"] },
        linked,
      ),
    ).toBe(true);
    expect(
      shouldDefaultUnlinkedJobToLocalOnly(
        { id: "linked-job", appIds: ["app-a"] },
        linked,
      ),
    ).toBe(false);
  });
});
