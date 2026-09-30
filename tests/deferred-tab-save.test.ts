import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const saveTabs = vi.fn();

vi.mock("../src/gateway/services/storage/AppStateStorage.js", () => ({
  getAppStateStorage: () => ({ saveTabs }),
}));

vi.mock("../src/gateway/services/workspaceWriteGuard.js", () => ({
  getWorkspaceWriteGeneration: vi.fn(() => 1),
}));

describe("deferredTabSave", () => {
  beforeEach(() => {
    saveTabs.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDeferredTabSaveForTests } = await import(
      "../src/gateway/services/storage/deferredTabSave.js"
    );
    resetDeferredTabSaveForTests();
  });

  it("coalesces rapid saves and flushes on setImmediate", async () => {
    const { scheduleDeferredTabSave } = await import(
      "../src/gateway/services/storage/deferredTabSave.js"
    );

    const first = [{ id: "tab-1" }] as never;
    const second = [{ id: "tab-1" }, { id: "tab-2" }] as never;

    scheduleDeferredTabSave(first);
    scheduleDeferredTabSave(second);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(saveTabs).toHaveBeenCalledTimes(1);
    expect(saveTabs).toHaveBeenCalledWith(second);
  });

  it("discardDeferredTabSave prevents a scheduled flush", async () => {
    const { scheduleDeferredTabSave, discardDeferredTabSave } = await import(
      "../src/gateway/services/storage/deferredTabSave.js"
    );

    scheduleDeferredTabSave([{ id: "tab-a" }] as never);
    discardDeferredTabSave("workspace switch");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(saveTabs).not.toHaveBeenCalled();
  });

  it("drops stale saves when workspace generation changes", async () => {
    const { getWorkspaceWriteGeneration } = await import(
      "../src/gateway/services/workspaceWriteGuard.js"
    );
    vi.mocked(getWorkspaceWriteGeneration).mockReturnValueOnce(1);

    const { scheduleDeferredTabSave } = await import(
      "../src/gateway/services/storage/deferredTabSave.js"
    );

    scheduleDeferredTabSave([{ id: "tab-a" }] as never);
    vi.mocked(getWorkspaceWriteGeneration).mockReturnValue(2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(saveTabs).not.toHaveBeenCalled();
  });
});
