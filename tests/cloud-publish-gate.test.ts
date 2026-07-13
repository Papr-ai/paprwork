import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/gateway/websocket/settings.js", () => ({
  loadSettings: vi.fn(),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(),
}));

import { loadSettings } from "../src/gateway/websocket/settings.js";
import { getPaprApiKey } from "../src/gateway/utils/keyResolver.js";
import { checkCloudPublishAvailable } from "../src/gateway/utils/cloudPublishGate.js";

describe("checkCloudPublishAvailable", () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockResolvedValue({
      profile: { name: "", email: "", imageUrl: "" },
      permissions: { fileSystem: true, network: true, calendar: false },
      codeIndexing: { enabled: true, excludedFolders: [] },
      uiPreferences: {
        lastModelId: null,
        onboardingDismissed: false,
        onboardingStep1Completed: false,
        onboardingStep2Completed: false,
        onboardingStep3Completed: false,
      },
      preferences: {
        defaultHomeAppId: null,
        cloudSyncEnabled: true,
        cloudAutoPublishEnabled: true,
      },
    });
    vi.mocked(getPaprApiKey).mockResolvedValue("sk-test");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns available when cloud sync and papr key are set", async () => {
    await expect(checkCloudPublishAvailable()).resolves.toEqual({
      available: true,
    });
  });

  it("returns export fallback when cloud sync is disabled", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      profile: { name: "", email: "", imageUrl: "" },
      permissions: { fileSystem: true, network: true, calendar: false },
      codeIndexing: { enabled: true, excludedFolders: [] },
      uiPreferences: {
        lastModelId: null,
        onboardingDismissed: false,
        onboardingStep1Completed: false,
        onboardingStep2Completed: false,
        onboardingStep3Completed: false,
      },
      preferences: {
        defaultHomeAppId: null,
        cloudSyncEnabled: false,
        cloudAutoPublishEnabled: true,
      },
    });

    const result = await checkCloudPublishAvailable();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.fallbackTool).toBe("export_app_bundle");
      expect(result.error).toContain("Cloud Sync is disabled");
      expect(result.recommendation).toContain("export_app_bundle");
    }
  });

  it("returns export fallback when papr login is missing", async () => {
    vi.mocked(getPaprApiKey).mockResolvedValue(null);

    const result = await checkCloudPublishAvailable();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.fallbackTool).toBe("export_app_bundle");
      expect(result.error).toContain("Papr login");
    }
  });
});
