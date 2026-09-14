import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("tursoPullScheduler first data paint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reconcile on index.html alone until first data paint", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({ enabled: true }),
    }));
    vi.doMock("../src/gateway/services/tursoSyncSession.js", () => ({
      reconcileLinkedSourcesFromCloud: reconcile,
    }));

    const {
      markTursoPullSchedulerGatewayBoot,
      scheduleTursoPullForAppOpen,
      notifyMiniAppFirstDataPaint,
    } = await import("../src/gateway/services/tursoPullScheduler.js");

    markTursoPullSchedulerGatewayBoot();
    vi.advanceTimersByTime(10_000);

    scheduleTursoPullForAppOpen("app-leads");
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();

    notifyMiniAppFirstDataPaint("app-leads");
    vi.advanceTimersByTime(3_500);
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledWith(
      { enabled: true },
      { appId: "app-leads" },
      { trigger: "app_open" },
    );
  });

  it("reconciles after max wait when the app never reads DB", async () => {
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
    vi.advanceTimersByTime(10_000);

    scheduleTursoPullForAppOpen("app-static");
    vi.advanceTimersByTime(120_000);
    await Promise.resolve();
    vi.advanceTimersByTime(3_500);
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalled();
  });
});
