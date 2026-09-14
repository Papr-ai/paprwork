import { afterEach, describe, expect, test, vi } from "vitest";
import {
  enterInteractiveHotPath,
  getInteractiveHotPathDepth,
  leaveInteractiveHotPath,
} from "../src/gateway/services/gatewayInteractivePriority.js";
import {
  clearBackgroundTaskTimingsForTests,
  getRecentBackgroundTaskTimings,
  resetCoalescedBackgroundWorkForTests,
  resolveSlowBackgroundTelemetryThresholdMs,
  scheduleCoalescedBackgroundWork,
  yieldToInteractiveHotPath,
} from "../src/gateway/services/gatewayBackgroundWork.js";

describe("gatewayBackgroundWork", () => {
  afterEach(() => {
    while (getInteractiveHotPathDepth() > 0) {
      leaveInteractiveHotPath();
    }
    resetCoalescedBackgroundWorkForTests();
    clearBackgroundTaskTimingsForTests();
  });

  test("yieldToInteractiveHotPath proceeds when hot path idle", async () => {
    const started = Date.now();
    await yieldToInteractiveHotPath("test-idle", {
      minQuietMs: 50,
      maxWaitMs: 5000,
      pollMs: 25,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("scheduleCoalescedBackgroundWork runs scheduled work", async () => {
    const prevQuiet = process.env.GATEWAY_BG_QUIET_MS;
    const prevMax = process.env.GATEWAY_BG_MAX_WAIT_MS;
    process.env.GATEWAY_BG_QUIET_MS = "0";
    process.env.GATEWAY_BG_MAX_WAIT_MS = "0";
    try {
      const work = vi.fn(async () => {});
      scheduleCoalescedBackgroundWork("test-coalesce", work);
      await new Promise((r) => setTimeout(r, 150));
      expect(work).toHaveBeenCalled();
      const timings = getRecentBackgroundTaskTimings();
      expect(timings.some((t) => t.taskKey === "test-coalesce" && t.ok)).toBe(
        true,
      );
    } finally {
      if (prevQuiet === undefined) {
        delete process.env.GATEWAY_BG_QUIET_MS;
      } else {
        process.env.GATEWAY_BG_QUIET_MS = prevQuiet;
      }
      if (prevMax === undefined) {
        delete process.env.GATEWAY_BG_MAX_WAIT_MS;
      } else {
        process.env.GATEWAY_BG_MAX_WAIT_MS = prevMax;
      }
    }
  });

  test("resolveSlowBackgroundTelemetryThresholdMs defaults to 10s", () => {
    const prev = process.env.GATEWAY_BG_SLOW_TELEMETRY_MS;
    delete process.env.GATEWAY_BG_SLOW_TELEMETRY_MS;
    try {
      expect(resolveSlowBackgroundTelemetryThresholdMs()).toBe(10_000);
    } finally {
      if (prev === undefined) {
        delete process.env.GATEWAY_BG_SLOW_TELEMETRY_MS;
      } else {
        process.env.GATEWAY_BG_SLOW_TELEMETRY_MS = prev;
      }
    }
  });

  test("yield proceeds after max wait when hot path stays busy", async () => {
    enterInteractiveHotPath("block");
    const started = Date.now();
    await yieldToInteractiveHotPath("test-busy", {
      minQuietMs: 5000,
      maxWaitMs: 80,
      pollMs: 20,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    leaveInteractiveHotPath();
  });
});
