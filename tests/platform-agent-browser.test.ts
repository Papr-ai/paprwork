import { describe, expect, it, vi, beforeEach } from "vitest";

const mockIsCloudAgentGatewayMode = vi.fn(() => false);
const mockIsGoogleChromeInstalled = vi.fn(() => true);

vi.mock("../src/core/utils/paprRoot.js", () => ({
  isCloudAgentGatewayMode: () => mockIsCloudAgentGatewayMode(),
}));

vi.mock("../src/gateway/services/platforms/platformChromeEnv.js", () => ({
  isGoogleChromeInstalled: () => mockIsGoogleChromeInstalled(),
}));

describe("shouldUseRealChromeProfile", () => {
  beforeEach(() => {
    mockIsCloudAgentGatewayMode.mockReturnValue(false);
    mockIsGoogleChromeInstalled.mockReturnValue(true);
    vi.unstubAllEnvs();
  });

  it("returns true for built-in platforms on desktop when Chrome is installed", async () => {
    const { shouldUseRealChromeProfile } = await import(
      "../src/gateway/services/platforms/platformAgentBrowser.js"
    );
    expect(shouldUseRealChromeProfile("linkedin")).toBe(true);
    expect(shouldUseRealChromeProfile("instagram")).toBe(true);
    expect(shouldUseRealChromeProfile("reddit")).toBe(true);
  });

  it("returns false for linkedin in cloud agent mode", async () => {
    mockIsCloudAgentGatewayMode.mockReturnValue(true);
    const { shouldUseRealChromeProfile } = await import(
      "../src/gateway/services/platforms/platformAgentBrowser.js"
    );
    expect(shouldUseRealChromeProfile("linkedin")).toBe(false);
  });

  it("returns false for unknown platforms", async () => {
    const { shouldUseRealChromeProfile } = await import(
      "../src/gateway/services/platforms/platformAgentBrowser.js"
    );
    expect(shouldUseRealChromeProfile("not-a-platform")).toBe(false);
  });

  it("returns false when Chrome is not installed", async () => {
    mockIsGoogleChromeInstalled.mockReturnValue(false);
    const { shouldUseRealChromeProfile } = await import(
      "../src/gateway/services/platforms/platformAgentBrowser.js"
    );
    expect(shouldUseRealChromeProfile("linkedin")).toBe(false);
  });

  it("returns false when PLAYWRIGHT_DOCKER is set", async () => {
    vi.stubEnv("PLAYWRIGHT_DOCKER", "1");
    const { shouldUseRealChromeProfile } = await import(
      "../src/gateway/services/platforms/platformAgentBrowser.js"
    );
    expect(shouldUseRealChromeProfile("linkedin")).toBe(false);
  });
});

describe("isGoogleChromeInstalled", () => {
  it("detects Chrome on darwin when app bundle exists", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (path: string) =>
          path.includes("Google Chrome.app") || actual.existsSync(path),
      };
    });
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { isGoogleChromeInstalled } = await import(
      "../src/gateway/services/platforms/platformChromeEnv.js"
    );
    expect(isGoogleChromeInstalled()).toBe(true);
  });
});
