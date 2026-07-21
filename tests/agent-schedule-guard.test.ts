import { describe, expect, it } from "vitest";
import {
  AGENT_SCHEDULE_APPROVAL_MAX_MS,
  AGENT_SCHEDULE_WARNING_MAX_MS,
  assessAgentJobSchedule,
  estimateScheduleIntervalMs,
  requiresScheduleRiskAcknowledgment,
} from "../src/gateway/services/jobs/agentScheduleGuard.js";

describe("agentScheduleGuard", () => {
  it("allows hourly agent cron schedules", () => {
    const result = assessAgentJobSchedule("agent", {
      enabled: true,
      cron: "0 * * * *",
    });
    expect(result.level).toBe("ok");
    expect(result.intervalMs).toBe(AGENT_SCHEDULE_WARNING_MAX_MS);
  });

  it("requires approval for agent jobs every 15 minutes", () => {
    const result = assessAgentJobSchedule("agent", {
      enabled: true,
      cron: "*/15 * * * *",
    });
    expect(result.level).toBe("approval_required");
    expect(result.message).toContain("Approve");
    expect(result.intervalMs).toBe(15 * 60 * 1000);
  });

  it("requires approval for agent jobs every 30 minutes", () => {
    const result = assessAgentJobSchedule("agent", {
      enabled: true,
      cron: "*/30 * * * *",
    });
    expect(result.level).toBe("approval_required");
  });

  it("warns for agent jobs between 30 and 60 minutes", () => {
    const result = assessAgentJobSchedule("agent", {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    expect(result.level).toBe("warning");
  });

  it("allows frequent schedules for python jobs", () => {
    const result = assessAgentJobSchedule("python", {
      enabled: true,
      cron: "*/5 * * * *",
    });
    expect(result.level).toBe("ok");
  });

  it("requires ack when high-frequency schedule not yet approved", () => {
    expect(
      requiresScheduleRiskAcknowledgment("agent", {
        enabled: true,
        cron: "*/15 * * * *",
      }),
    ).toBe(true);
    expect(
      requiresScheduleRiskAcknowledgment("agent", {
        enabled: true,
        cron: "*/15 * * * *",
        highFrequencyAcknowledgedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("estimates cron interval from consecutive fires", () => {
    const interval = estimateScheduleIntervalMs({
      enabled: true,
      cron: "0 6 * * *",
    });
    expect(interval).toBe(24 * 60 * 60 * 1000);
  });
});
