import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const mockBridge = {
  enabled: true,
  getAppsRootDir: () => "/tmp/apps",
  listLinkedSources: vi.fn(async () => []),
};

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: vi.fn(() => mockBridge),
}));

vi.mock("../src/gateway/services/cloudUploadMode.js", () => ({
  shouldAutoUploadJobFolder: vi.fn(() => true),
  shouldAutoUploadTursoForApp: vi.fn(() => true),
}));

describe("cancelAllScheduledTursoPushes", () => {
  useIsolatedPaprWorkspace("turso-push-cancel");

  beforeEach(async () => {
    vi.useFakeTimers();
    const { resetTursoPushQueueForTests } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );
    resetTursoPushQueueForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears debounced push timers scheduled before workspace switch", async () => {
    const { scheduleTursoPushForJob, cancelAllScheduledTursoPushes } =
      await import("../src/gateway/services/tursoPushScheduler.js");

    scheduleTursoPushForJob("db-test", "normal", "watcher");
    // Routing to the legacy scheduler happens after an async import.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));

    cancelAllScheduledTursoPushes("unit test");

    expect(vi.getTimerCount()).toBe(0);
  });
});
