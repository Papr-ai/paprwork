import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBridge = vi.fn();
const mockGetPaprRoot = vi.fn(() => "/tmp/papr-startup-ws");
const mockPrune = vi.fn(() => 2);
const mockDiscover = vi.fn(async () => []);

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: () => mockGetBridge(),
}));

vi.mock("../src/gateway/services/tursoLinkedSources.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/gateway/services/tursoLinkedSources.js")>();
  return {
    ...original,
    discoverTursoLinkedSources: (...args: unknown[]) => mockDiscover(...args),
  };
});

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: () => mockGetPaprRoot(),
  defaultAppsRoot: () => "/tmp/papr-apps",
}));

vi.mock("../src/gateway/services/tursoSyncState.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/gateway/services/tursoSyncState.js")>();
  return {
    ...original,
    pruneTursoSyncStateForWorkspace: (...args: unknown[]) => mockPrune(...args),
  };
});

describe("pushDirtyLinkedJobsOnStartup", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetBridge.mockReturnValue({
      enabled: true,
      getAppsRootDir: () => "/tmp/papr-apps",
    });
  });

  it("returns early when Turso sync is disabled", async () => {
    mockGetBridge.mockReturnValue({ enabled: false });
    const { pushDirtyLinkedJobsOnStartup } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );

    await pushDirtyLinkedJobsOnStartup();

    expect(mockPrune).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("prunes active workspace sync state before scanning linked jobs", async () => {
    const { pushDirtyLinkedJobsOnStartup } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );

    await pushDirtyLinkedJobsOnStartup("/custom/apps/root");

    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockPrune).toHaveBeenCalledWith("/tmp/papr-startup-ws");
    expect(mockDiscover).toHaveBeenCalledWith("/custom/apps/root");
  });
});
