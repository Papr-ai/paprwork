import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPaprApiKey = vi.fn();
const mockLoadSettings = vi.fn();
const mockIsSyncV3FlagEnabled = vi.fn();

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: (...args: unknown[]) => mockGetPaprApiKey(...args),
}));

vi.mock("../src/gateway/services/settingsStore.js", () => ({
  loadSettings: (...args: unknown[]) => mockLoadSettings(...args),
}));

vi.mock("../src/gateway/services/syncV3/syncV3Flags.js", () => ({
  isSyncV3FlagEnabled: (...args: unknown[]) => mockIsSyncV3FlagEnabled(...args),
}));

describe("isCloudSchedulerAuthoritative cache", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetPaprApiKey.mockReset();
    mockLoadSettings.mockReset();
    mockIsSyncV3FlagEnabled.mockReset();
    mockIsSyncV3FlagEnabled.mockReturnValue(true);
    mockLoadSettings.mockResolvedValue({
      preferences: { cloudSyncEnabled: true },
    });
    mockGetPaprApiKey.mockResolvedValue("sk-test");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches authoritative result for subsequent calls", async () => {
    const mod = await import("../src/gateway/utils/cloudSchedulerAuthority.js");

    await expect(mod.isCloudSchedulerAuthoritative()).resolves.toBe(true);
    await expect(mod.isCloudSchedulerAuthoritative()).resolves.toBe(true);

    expect(mockGetPaprApiKey).toHaveBeenCalledTimes(1);
    expect(mockLoadSettings).toHaveBeenCalledTimes(1);
  });

  it("clears cache when clearCloudSchedulerAuthorityCache is called", async () => {
    const mod = await import("../src/gateway/utils/cloudSchedulerAuthority.js");

    await mod.isCloudSchedulerAuthoritative();
    mod.clearCloudSchedulerAuthorityCache();
    await mod.isCloudSchedulerAuthoritative();

    expect(mockGetPaprApiKey).toHaveBeenCalledTimes(2);
  });
});
