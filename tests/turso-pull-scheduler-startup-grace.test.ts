import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("tursoPullScheduler startup grace", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips app-open pull during startup grace window", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({ enabled: true }),
    }));
    vi.doMock("../src/gateway/services/tursoSyncSession.js", () => ({
      reconcileLinkedSourcesFromCloud: reconcile,
    }));

    const { markTursoPullSchedulerGatewayBoot, scheduleTursoPullForAppOpen } =
      await import("../src/gateway/services/tursoPullScheduler.js");

    markTursoPullSchedulerGatewayBoot();
    scheduleTursoPullForAppOpen("app-test");

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("schedules app-open pull after startup grace expires", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({ enabled: true }),
    }));
    vi.doMock("../src/gateway/services/tursoSyncSession.js", () => ({
      reconcileLinkedSourcesFromCloud: reconcile,
    }));

    const { markTursoPullSchedulerGatewayBoot, scheduleTursoPullForAppOpen } =
      await import("../src/gateway/services/tursoPullScheduler.js");

    markTursoPullSchedulerGatewayBoot();
    vi.advanceTimersByTime(9_000);

    scheduleTursoPullForAppOpen("app-test");
    vi.advanceTimersByTime(3_500);
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalled();
  });
});
